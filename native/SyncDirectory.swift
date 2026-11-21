import CryptoKit
import Foundation

struct JournalFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

struct JournalPhoto: Codable {
  let hash: String
  let bytes: Int
  let mime: String

  var ext: String {
    get throws {
      let types = [
        "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
      ]
      guard let value = types[mime], (1...20 * 1024 * 1024).contains(bytes),
        hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
      else { throw JournalFailure("照片清单无效") }
      return value
    }
  }
  func verify(_ data: Data) throws {
    _ = try ext
    guard data.count == bytes,
      SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == hash
    else {
      throw JournalFailure("照片大小或哈希不符，等待完整文件后重试。")
    }
    let valid: Bool
    switch mime {
    case "image/jpeg":
      valid = data.starts(with: [255, 216, 255]) && data.suffix(2) == Data([255, 217])
    case "image/png":
      valid =
        data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) && data.count >= 45
        && data.suffix(8).prefix(4) == Data("IEND".utf8)
    case "image/gif":
      valid =
        ["GIF87a", "GIF89a"].contains(String(decoding: data.prefix(6), as: UTF8.self))
        && data.last == 59
    default:
      valid =
        data.starts(with: Data("RIFF".utf8)) && data.dropFirst(8).starts(with: Data("WEBP".utf8))
        && data.count >= 16
        && data.prefix(8).dropFirst(4).enumerated().reduce(
          0, { $0 | (Int($1.element) << (8 * $1.offset)) }) + 8 == data.count
    }
    guard valid else { throw JournalFailure("照片格式或文件结尾不完整") }
  }
}

// Both platforms use exactly the same file coordination, wire encryption and attachment checks.
final class SyncDirectory {
  let root: URL
  let archive: String
  private let key: SymmetricKey
  private let fm = FileManager.default
  private let marker = "bodyjournal.archive"
  private let markerText = Data("身体手记共享目录 v1".utf8)
  private let guid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

  init(root: URL, code: String) throws {
    let parts = code.split(separator: ".")
    guard parts.count == 3, parts[0] == "BJ1", UUID(uuidString: String(parts[1])) != nil,
      parts[1] == parts[1].lowercased(), let bytes = Data(base64Encoded: String(parts[2])),
      bytes.count == 32
    else { throw JournalFailure("配对码格式不完整") }
    self.root = root.standardizedFileURL
    archive = String(parts[1])
    key = SymmetricKey(data: bytes)
  }
  private func coordinated<T>(_ url: URL, writing: Bool, _ body: (URL) throws -> T) throws -> T {
    var failure: NSError?
    var result: Result<T, Error>?
    let access: (URL) -> Void = { target in result = Result { try body(target) } }
    let coordinator = NSFileCoordinator(filePresenter: nil)
    if writing {
      coordinator.coordinate(writingItemAt: url, options: [], error: &failure, byAccessor: access)
    } else {
      coordinator.coordinate(readingItemAt: url, options: [], error: &failure, byAccessor: access)
    }
    if let error = failure { throw error }
    guard let result = result else { throw JournalFailure("目录暂时不可访问，请重新授权并重试。") }
    return try result.get()
  }
  private func allowed(_ name: String) -> Bool {
    name.range(
      of: "^(op-\(guid)|ack-\(guid)-\(guid)|img-[a-f0-9]{64})$", options: .regularExpression) != nil
  }
  private func plain(_ data: Data, _ name: String) throws -> Data {
    do {
      return try AES.GCM.open(
        AES.GCM.SealedBox(combined: data), using: key,
        authenticating: Data(("bodyjournal/1/" + archive + "/" + name).utf8))
    } catch { throw JournalFailure("档案、恢复码或文件校验不匹配，请核对目录和配对码。") }
  }
  private func sealed(_ data: Data, _ name: String) throws -> Data {
    guard
      let box = try AES.GCM.seal(
        data, using: key, authenticating: Data(("bodyjournal/1/" + archive + "/" + name).utf8)
      ).combined
    else { throw JournalFailure("文件加密失败") }
    return box
  }
  private func download(_ url: URL) {
    try? fm.startDownloadingUbiquitousItem(at: url)
  }
  private func localBytes(_ url: URL, limit: Int) throws -> Data {
    let info = try url.resourceValues(forKeys: [
      .isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey, .ubiquitousItemDownloadingStatusKey,
    ])
    if let status = info.ubiquitousItemDownloadingStatus, status == .notDownloaded {
      download(url)
      throw JournalFailure("iCloud 正在下载，请稍后点「立即同步」。")
    }
    guard info.isSymbolicLink != true, info.isRegularFile == true, let size = info.fileSize,
      size <= limit
    else { throw JournalFailure("文件类型或大小无效") }
    return try Data(contentsOf: url)
  }
  func bind(create: Bool) throws {
    let props = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard props.isDirectory == true, props.isSymbolicLink != true else {
      throw JournalFailure("请重新选择共享文件夹。")
    }
    let url = root.appendingPathComponent(marker)
    if create {
      try coordinated(root, writing: true) { directory in
        let names = try self.fm.contentsOfDirectory(atPath: directory.path).filter {
          $0 != ".DS_Store"
        }
        if names.isEmpty {
          try self.sealed(self.markerText, self.marker).write(
            to: directory.appendingPathComponent(self.marker), options: .atomic)
        } else if !names.contains(self.marker) && !names.contains("." + self.marker + ".icloud") {
          throw JournalFailure("新档案需要单独的空目录，请在 iCloud Drive 中新建文件夹。")
        }
      }
    }
    if !fm.fileExists(atPath: url.path) {
      download(url)
      throw JournalFailure("找不到已配对的档案标记，请选择原目录或等待 iCloud 下载。")
    }
    let data = try coordinated(url, writing: false) { try self.localBytes($0, limit: 1024) }
    guard try plain(data, marker) == markerText else { throw JournalFailure("目录标识不一致") }
  }
  func list() throws -> [String] {
    try coordinated(root, writing: false) { dir in
      let names = try self.fm.contentsOfDirectory(atPath: dir.path)
      for name in names where name.hasPrefix(".") && name.hasSuffix(".icloud") {
        let original = String(name.dropFirst().dropLast(7))
        if self.allowed(original) { self.download(dir.appendingPathComponent(original)) }
      }
      return names.filter { self.allowed($0) && !$0.hasPrefix("img-") }.sorted()
    }
  }
  func read(_ name: String) throws -> Data {
    guard allowed(name) else { throw JournalFailure("无效的共享文件名") }
    let url = root.appendingPathComponent(name)
    if !fm.fileExists(atPath: url.path) {
      download(url)
      throw JournalFailure("文件尚未抵达，稍后会继续下载。")
    }
    let limit = name.hasPrefix("img-") ? 20 * 1024 * 1024 + 28 : 1024 * 1024
    return try coordinated(url, writing: false) {
      try self.plain(self.localBytes($0, limit: limit), name)
    }
  }
  func write(_ name: String, data: Data) throws {
    guard allowed(name) else { throw JournalFailure("无效的共享文件名") }
    let url = root.appendingPathComponent(name)
    try coordinated(url, writing: true) { target in
      if self.fm.fileExists(atPath: target.path) {
        let existing = try self.localBytes(target, limit: data.count + 28)
        guard try self.plain(existing, name) == data else {
          throw JournalFailure("同编号文件的内容不同，请核对档案。")
        }
      } else {
        if self.fm.fileExists(atPath: self.root.appendingPathComponent("." + name + ".icloud").path)
        {
          self.download(target)
          throw JournalFailure("已有文件正在下载，请稍后重试。")
        }
        try self.sealed(data, name).write(to: target, options: .atomic)
      }
    }
  }
  func transfer(_ photo: JournalPhoto, local: URL, upload: Bool) throws {
    let name = "img-" + photo.hash
    if upload && fm.fileExists(atPath: local.path) {
      let data = try localBytes(local, limit: photo.bytes)
      try photo.verify(data)
      try write(name, data: data)
    } else {
      if fm.fileExists(atPath: local.path), let saved = try? localBytes(local, limit: photo.bytes),
        (try? photo.verify(saved)) != nil
      {
        return
      }
      let data = try read(name)
      try photo.verify(data)
      try fm.createDirectory(
        at: local.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: local, options: .atomic)
    }
  }
  func perform(_ args: [String: Any], localRoot: URL, byRecord: Bool) throws -> [String: Any] {
    let command = args["command"] as? String
    try bind(create: command == "create")
    switch command {
    case "create", "bind": return [:]
    case "list": return ["names": try list()]
    case "read":
      return ["text": String(decoding: try read(args["name"] as? String ?? ""), as: UTF8.self)]
    case "write":
      guard let text = args["text"] as? String, text.utf8.count < 1024 * 1024 else {
        throw JournalFailure("变更过大")
      }
      try write(args["name"] as? String ?? "", data: Data(text.utf8))
      return [:]
    case "photo":
      guard let raw = args["photo"], let id = args["record"] as? String,
        id.range(of: "^[A-Za-z0-9_-]{8,100}$", options: .regularExpression) != nil
      else { throw JournalFailure("照片引用无效") }
      let photo = try JSONDecoder().decode(
        JournalPhoto.self, from: JSONSerialization.data(withJSONObject: raw))
      let base = byRecord ? localRoot.appendingPathComponent(id) : localRoot
      let file = base.appendingPathComponent(try photo.hash + "." + photo.ext)
      try transfer(photo, local: file, upload: args["upload"] as? Bool == true)
      return [:]
    default: throw JournalFailure("未知目录操作")
    }
  }
}
