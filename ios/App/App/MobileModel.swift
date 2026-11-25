import Capacitor
import Foundation
import CryptoKit
import Network
import SafariServices
import Security

// The authorization server requires an IPv4 loopback redirect, including on phones.
final class MobileModel: NSObject, SFSafariViewControllerDelegate, URLSessionTaskDelegate {
  private var listener: NWListener?
  private var browser: SFSafariViewController?
  private var completion: CAPPluginCall?
  private var timer: DispatchWorkItem?
  private var redirect = ""
  private var state = ""
  private var connections: [NWConnection] = []
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 90
    config.timeoutIntervalForResource = 240
    config.urlCache = nil
    config.httpShouldSetCookies = false
    return URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }()
  private let routes = [
    "keys": "https://auth.openai.com/.well-known/jwks.json",
    "token": "https://auth.openai.com/api/accounts/oauth/token",
    "models": "https://api.openai.com/v1/models",
    "responses": "https://api.openai.com/v1/responses",
    "deepseek": "https://api.deepseek.com/chat/completions"
  ]
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }

  func handle(_ method: String, _ call: CAPPluginCall, presenter: UIViewController?) {
    do {
      switch method {
      case "modelDigest":
        guard let value = call.getString("text") else { throw JournalFailure("缺少待校验数据。") }
        let digest = Data(SHA256.hash(data: Data(value.utf8)))
        call.resolve(["base64": digest.base64EncodedString(), "hex": digest.map { String(format: "%02x", $0) }.joined()])
      case "modelVerify":
        guard let n = call.getString("n"), let e = call.getString("e"), let sig = call.getString("signature"),
          let signed = call.getString("signed") else { throw JournalFailure("身份签名不完整。") }
        func decode(_ s: String) -> Data? {
          let raw = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
          return Data(base64Encoded: raw + String(repeating: "=", count: (4 - raw.count % 4) % 4))
        }
        func tlv(_ tag: UInt8, _ bytes: Data) -> Data {
          var n = bytes.count
          var len = [UInt8]()
          if n < 128 { len = [UInt8(n)] } else {
            while n > 0 { len.insert(UInt8(n & 255), at: 0); n >>= 8 }
            len.insert(0x80 | UInt8(len.count), at: 0)
          }
          return Data([tag] + len) + bytes
        }
        func integer(_ v: Data) -> Data { tlv(2, (v.first ?? 0) >= 128 ? Data([0]) + v : v) }
        guard let mod = decode(n), mod.count >= 256, let exp = decode(e), let signature = decode(sig),
          let key = SecKeyCreateWithData(tlv(48, integer(mod) + integer(exp)) as CFData,
            [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic] as CFDictionary, nil),
          SecKeyVerifySignature(key, .rsaSignatureMessagePKCS1v15SHA256, Data(signed.utf8) as CFData, signature as CFData, nil)
        else { throw JournalFailure("ChatGPT 身份签名校验失败。") }
        call.resolve()
      case "modelAuthorize":
        try start(call, presenter: presenter)
      case "modelRead", "modelWrite":
        guard let name = call.getString("name"), ["registration", "deepseek", "host"].contains(name)
        else { throw JournalFailure("无效的凭据名称。") }
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: "local.bodyjournal.models.v1", kSecAttrAccount as String: name]
        if method == "modelRead" {
          query[kSecReturnData as String] = true
          var result: CFTypeRef?
          let status = SecItemCopyMatching(query as CFDictionary, &result)
          guard status == errSecSuccess || status == errSecItemNotFound else { throw JournalFailure("请解锁手机后读取凭据。") }
          call.resolve(["value": (result as? Data).flatMap { String(data: $0, encoding: .utf8) } as Any? ?? NSNull()])
        } else if let value = call.getString("value"), !value.isEmpty {
          guard value.utf8.count <= 65536 else { throw JournalFailure("凭据过长。") }
          let data = Data(value.utf8)
          var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
          if status == errSecItemNotFound {
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            query[kSecValueData as String] = data
            status = SecItemAdd(query as CFDictionary, nil)
          }
          guard status == errSecSuccess else { throw JournalFailure("无法保存到本机钥匙串。") }
          call.resolve()
        } else {
          let status = SecItemDelete(query as CFDictionary)
          guard status == errSecSuccess || status == errSecItemNotFound else { throw JournalFailure("无法清除凭据。") }
          call.resolve()
        }
      case "modelFetch":
        guard let route = call.getString("route"), let endpoint = routes[route], let url = URL(string: endpoint)
        else { throw JournalFailure("未知模型服务。") }
        var req = URLRequest(url: url)
        if let auth = call.getString("bearer"), ["models", "responses", "deepseek"].contains(route) {
          guard !auth.contains("\n"), !auth.contains("\r") else { throw JournalFailure("凭据格式错误。") }
          req.setValue("Bearer " + auth, forHTTPHeaderField: "Authorization")
        }
        if ["token", "responses", "deepseek"].contains(route) {
          guard let body = call.getString("body"), body.utf8.count <= 48 * 1024 * 1024 else { throw JournalFailure("请求过大，请减少所选照片。") }
          req.httpMethod = "POST"
          req.setValue(route == "token" ? "application/x-www-form-urlencoded" : "application/json", forHTTPHeaderField: "Content-Type")
          req.httpBody = Data(body.utf8)
        }
        session.dataTask(with: req) { data, response, error in
          if let error { call.reject(error.localizedDescription); return }
          guard let response = response as? HTTPURLResponse, let data, data.count <= 16 * 1024 * 1024,
            let body = String(data: data, encoding: .utf8) else { call.reject("服务响应无效。"); return }
          call.resolve(["status": response.statusCode, "body": body])
        }.resume()
      default: throw JournalFailure("未知的模型操作。")
      }
    } catch { call.reject(error.localizedDescription) }
  }
  private func start(_ call: CAPPluginCall, presenter: UIViewController?) throws {
    guard completion == nil, let presenter, presenter.presentedViewController == nil else { throw JournalFailure("请先完成当前登录。") }
    guard let items = call.getObject("params") as? [String: String],
      let expected = items["state"], expected.count >= 32 else { throw JournalFailure("缺少登录校验参数。") }
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let server = try NWListener(using: params)
    completion = call
    listener = server
    state = expected
    server.newConnectionHandler = { [weak self] conn in self?.receive(conn) }
    server.stateUpdateHandler = { [weak self, weak presenter, weak server] status in
      guard let self, let server, self.listener === server else { return }
      switch status {
      case .ready:
        guard let port = server.port, let presenter else { self.finish(nil, "本机登录端口不可用。"); return }
        self.redirect = "http://127.0.0.1:\(port.rawValue)/auth/callback"
        var query = items
        query["redirect_uri"] = self.redirect
        var url = URLComponents(string: "https://auth.openai.com/api/accounts/authorize")!
        url.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let address = url.url else { self.finish(nil, "无法生成登录地址。"); return }
        let browser = SFSafariViewController(url: address)
        browser.delegate = self
        self.browser = browser
        presenter.present(browser, animated: true)
      case .failed: self.finish(nil, "无法启动本机登录回调。")
      default: break
      }
    }
    let timeout = DispatchWorkItem { [weak self] in self?.finish(nil, "登录已超时，请重试。") }
    timer = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 180, execute: timeout)
    server.start(queue: .main)
  }
  private func receive(_ conn: NWConnection) {
    guard connections.count < 8 else { conn.cancel(); return }
    connections.append(conn)
    conn.start(queue: .main)
    func read(_ prior: Data) {
      conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, done, error in
        guard let self else { conn.cancel(); return }
        var bytes = prior
        bytes.append(data ?? Data())
        func close() { self.connections.removeAll { $0 === conn }; conn.cancel() }
        guard error == nil, bytes.count <= 16384 else { close(); return }
        guard let header = String(data: bytes, encoding: .utf8), header.contains("\r\n\r\n") else {
          if done { close() } else { read(bytes) }; return
        }
        let fields = header.components(separatedBy: "\r\n")[0].components(separatedBy: " ")
        let target = fields.count == 3 && fields[0] == "GET" ? fields[1] : ""
        let url = URLComponents(string: target)
        let valid = url?.scheme == nil && url?.host == nil && url?.path == "/auth/callback" &&
          url?.queryItems?.first(where: { $0.name == "state" })?.value == self.state && self.completion != nil
        let message = valid ? "Return to Body Journal to finish signing in." : "Invalid request."
        let response = "HTTP/1.1 " + (valid ? "200 OK" : "400 Bad Request") + "\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: text/plain\r\nContent-Length: \(message.utf8.count)\r\n\r\n" + message
        conn.send(content: Data(response.utf8), completion: .contentProcessed { _ in
          close()
          if valid { self.finish(["callback": target, "redirect": self.redirect], nil) }
        })
      }
    }
    read(Data())
  }
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) { finish(nil, "已取消登录。") }
  private func finish(_ result: [String: Any]?, _ error: String?) {
    let call = completion
    completion = nil
    timer?.cancel(); timer = nil
    listener?.cancel(); listener = nil
    connections.forEach { $0.cancel() }; connections.removeAll()
    browser?.dismiss(animated: true); browser = nil
    if let result { call?.resolve(result) } else if let error { call?.reject(error) }
  }
}
