import Capacitor
import CryptoKit
import ImageIO
import PhotosUI
import Security
import UIKit
import UniformTypeIdentifiers
import VisionKit

final class JournalViewController: CAPBridgeViewController {
  override func capacitorDidLoad() { bridge?.registerPluginInstance(JournalPlugin()) }
}

@objc(JournalPlugin)
final class JournalPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate,
  PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate
{
  let identifier = "JournalPlugin"
  let jsName = "Journal"
  let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise)
  ]
  private let queue = DispatchQueue(label: "bodyjournal.phone.storage", qos: .userInitiated)
  private let transfers = DispatchQueue(label: "bodyjournal.phone.files", qos: .utility)
  private var database: PhoneDatabase?
  private var pending: CAPPluginCall?
  private func db() throws -> PhoneDatabase {
    if let existing = database { return existing }
    let support = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let opened = try PhoneDatabase(
      root: support.appendingPathComponent("BodyJournal", isDirectory: true))
    database = opened
    return opened
  }
  private func identity(_ db: PhoneDatabase) throws -> [String: Any] {
    var device = try db.get("device")
    if device == nil {
      device = UUID().uuidString.lowercased()
      try db.set("device", device!)
    }
    var info: [String: Any] = ["device": device!, "enabled": try db.get("enabled") == "true"]
    info["archive"] = try db.get("archive")
    info["folder"] = try db.get("folderName")
    return info
  }
  private func keyQuery(_ archive: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "local.bodyjournal.sync.v1", kSecAttrAccount as String: archive,
    ]
  }
  private func readCode(_ archive: String) throws -> String {
    var query = keyQuery(archive)
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let bytes = result as? Data, let code = String(data: bytes, encoding: .utf8)
    else { throw JournalFailure("请解锁 iPhone，或用原恢复码重新配对。") }
    return code
  }
  private func saveCode(_ code: String, archive: String) throws {
    var query = keyQuery(archive)
    let bytes = Data(code.utf8)
    var status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
    if status == errSecItemNotFound {
      query[kSecValueData as String] = bytes
      query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      status = SecItemAdd(query as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw JournalFailure("钥匙串暂时不可用，请解锁后再试。") }
  }
  private func scoped<T>(_ url: URL, _ action: () throws -> T) throws -> T {
    guard url.startAccessingSecurityScopedResource() else {
      throw JournalFailure("目录授权已失效，请重选原目录。")
    }
    defer { url.stopAccessingSecurityScopedResource() }
    return try action()
  }
  // Only the storage queue touches SQLite. Coordinating a slow iCloud download happens on transfers.
  private func folder(_ args: [String: Any]) throws -> [String: Any] {
    let (archive, saved, photos): (String, String, URL) = try queue.sync {
      let store = try db()
      guard try store.get("enabled") == "true", let archive = try store.get("archive"),
        let saved = try store.get("bookmark")
      else { throw JournalFailure("请先配对并选择原目录。") }
      return (archive, saved, store.photos)
    }
    guard let data = Data(base64Encoded: saved) else { throw JournalFailure("请重选原目录以恢复授权。") }
    var stale = false
    let url = try URL(
      resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    return try scoped(url) {
      let dir = try SyncDirectory(root: url, code: readCode(archive))
      if stale {
        let renewed = try url.bookmarkData(
          options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil
        ).base64EncodedString()
        try queue.sync {
          let store = try db()
          if try store.get("bookmark") == saved { try store.set("bookmark", renewed) }
        }
      }
      return try dir.perform(args, localRoot: photos, byRecord: false)
    }
  }
  private func perform(_ call: CAPPluginCall, _ work: @escaping () throws -> [String: Any]) {
    queue.async {
      do { call.resolve(try work()) } catch { call.reject(error.localizedDescription) }
    }
  }
  @objc func request(_ call: CAPPluginCall) {
    let method = call.getString("method") ?? ""
    if ["pick", "choose", "scan"].contains(method) {
      DispatchQueue.main.async { self.presentPicker(method, call: call) }
      return
    }
    if method == "folder" {
      // iCloud file coordination can wait for a provider. Local saves use a separate queue.
      transfers.async { [self] in
        do {
          call.resolve(try folder(call.getObject("args") ?? [:]))
        } catch { call.reject(error.localizedDescription) }
      }
      return
    }
    perform(call) { [self] in
      let db = try self.db()
      switch method {
      case "identity": return try identity(db)
      case "rows": return ["rows": try db.rows()]
      case "row": return ["doc": (try db.row(call.getString("id") ?? "")) as Any? ?? NSNull()]
      case "save":
        guard let id = call.getString("id"), let previous = call.getInt("previous"),
          let doc = call.getString("doc")
        else { throw JournalFailure("记录内容不完整") }
        try db.save(id: id, previous: previous, doc: doc)
        return [:]
      case "pause":
        try db.set("enabled", "false")
        return try identity(db)
      case "code": return ["code": try readCode(db.get("archive") ?? "")]
      case "preview":
        guard let raw = call.getObject("photo") else { throw JournalFailure("照片引用缺失") }
        let ref = try JSONDecoder().decode(
          JournalPhoto.self, from: JSONSerialization.data(withJSONObject: raw))
        let file = db.photos.appendingPathComponent(try ref.hash + "." + ref.ext)
        guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
        let jpeg = try Self.jpeg(file, maxSize: call.getBool("full") == true ? 2048 : 400)
        return ["url": "data:image/jpeg;base64," + jpeg.base64EncodedString()]
      default: throw JournalFailure("未知的本机操作")
      }
    }
  }
  private func presentPicker(_ method: String, call: CAPPluginCall) {
    guard pending == nil, let view = bridge?.viewController else {
      call.reject("请先关闭已打开的系统选择器。")
      return
    }
    pending = call
    let picker: UIViewController
    if method == "choose" {
      let p = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
      p.delegate = self
      picker = p
    } else if method == "pick" {
      var config = PHPickerConfiguration(photoLibrary: .shared())
      config.filter = .images
      config.selection = .ordered
      config.selectionLimit = min(8, max(1, call.getInt("limit") ?? 8))
      let p = PHPickerViewController(configuration: config)
      p.delegate = self
      picker = p
    } else {
      if #available(iOS 16.0, *), DataScannerViewController.isSupported,
        DataScannerViewController.isAvailable
      {
        let scanner = DataScannerViewController(
          recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
          isHighlightingEnabled: true)
        scanner.delegate = self
        scanner.navigationItem.leftBarButtonItem = UIBarButtonItem(
          barButtonSystemItem: .cancel, target: self, action: #selector(cancelScan))
        scanner.navigationItem.title = "轻点配对二维码"
        let nav = UINavigationController(rootViewController: scanner)
        nav.isModalInPresentation = true
        view.present(nav, animated: true) {
          do { try scanner.startScanning() } catch {
            nav.dismiss(animated: true)
            self.failPicker(error.localizedDescription)
          }
        }
        return
      }
      failPicker("此设备暂时无法扫码，请填写 Mac 显示的配对码。")
      return
    }
    picker.presentationController?.delegate = self
    view.present(picker, animated: true)
  }
  private func failPicker(_ reason: String) {
    let call = pending
    pending = nil
    call?.reject(reason)
  }
  private func cancelled() {
    let call = pending
    pending = nil
    call?.resolve(["cancelled": true])
  }
  @objc private func cancelScan() {
    bridge?.viewController?.dismiss(animated: true)
    cancelled()
  }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    cancelled()
  }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { cancelled() }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL])
  {
    guard let call = pending, let url = urls.first else {
      cancelled()
      return
    }
    pending = nil
    perform(call) { [self] in
      try scoped(url) {
        let db = try self.db()
        let bound = try db.get("archive")
        let code = try call.getString("code") ?? readCode(bound ?? "")
        let dir = try SyncDirectory(root: url, code: code)
        if let bound = bound, bound != dir.archive { throw JournalFailure("此设备已经绑定另一档案，请使用原恢复码。") }
        try dir.bind(create: false)
        let bookmark = try url.bookmarkData(
          options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
        try saveCode(code, archive: dir.archive)
        try db.bindFolder(
          archive: dir.archive, bookmark: bookmark.base64EncodedString(),
          name: url.lastPathComponent)
        return try identity(db)
      }
    }
  }
  private static func jpeg(_ file: URL, maxSize: Int) throws -> Data {
    guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: maxSize,
        ] as CFDictionary)
    else { throw JournalFailure("照片暂时无法读取，请先在相册中下载后重试。") }
    let data = NSMutableData()
    guard
      let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
    else { throw JournalFailure("无法转换照片") }
    CGImageDestinationAddImage(
      dest, image, [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw JournalFailure("照片转换未完成") }
    return data as Data
  }
  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard let call = pending else { return }
    pending = nil
    if results.isEmpty {
      call.resolve(["photos": []])
      return
    }
    func load(_ i: Int, _ refs: [[String: Any]]) {
      guard i < results.count else {
        call.resolve(["photos": refs])
        return
      }
      let provider = results[i].itemProvider
      provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, error in
        // The picker only grants access to the temporary URL during this callback.
        do {
          guard let file = url else { throw error ?? JournalFailure("照片下载未完成") }
          let bytes = try Self.jpeg(file, maxSize: 3200)
          let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
          let ref = JournalPhoto(hash: hash, bytes: bytes.count, mime: "image/jpeg")
          try ref.verify(bytes)
          try self.queue.sync {
            let db = try self.db()
            try bytes.write(to: db.photos.appendingPathComponent(hash + ".jpeg"), options: .atomic)
          }
          load(i + 1, refs + [["hash": hash, "bytes": bytes.count, "mime": "image/jpeg"]])
        } catch { call.reject(error.localizedDescription) }
      }
    }
    load(0, [])
  }
}

@available(iOS 16.0, *)
extension JournalPlugin: DataScannerViewControllerDelegate {
  func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
    guard case .barcode(let barcode) = item, let code = barcode.payloadStringValue,
      code.hasPrefix("BJ1.")
    else { return }
    dataScanner.stopScanning()
    dataScanner.dismiss(animated: true)
    let call = pending
    pending = nil
    call?.resolve(["code": code])
  }
}
