import Foundation
import SQLite3

// Each JSON row includes the journal entry, its DAG and its durable outbox.
// The revision condition also protects edits that race with foreground sync.
final class PhoneDatabase {
  let root: URL
  let photos: URL
  private var db: OpaquePointer?
  private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
  init(root: URL) throws {
    self.root = root
    photos = root.appendingPathComponent("photos", isDirectory: true)
    try FileManager.default.createDirectory(at: photos, withIntermediateDirectories: true)
    var privateRoot = root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try privateRoot.setResourceValues(values)
    guard
      sqlite3_open_v2(
        root.appendingPathComponent("journal.sqlite").path, &db,
        SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK
    else { throw JournalFailure("无法打开本机档案。") }
    try execute(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS journal(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, doc TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,value TEXT NOT NULL);"
    )
  }
  deinit { sqlite3_close(db) }
  private func execute(_ sql: String) throws {
    if sqlite3_exec(db, sql, nil, nil, nil) != SQLITE_OK { throw failure() }
  }
  private func failure() -> JournalFailure {
    JournalFailure("本机保存或读取失败，请检查可用空间。 " + String(cString: sqlite3_errmsg(db)))
  }
  private func statement<T>(_ sql: String, _ strings: [String], _ read: (OpaquePointer) throws -> T)
    throws -> T
  {
    var ptr: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &ptr, nil) == SQLITE_OK, let ptr = ptr else {
      throw failure()
    }
    defer { sqlite3_finalize(ptr) }
    for (i, string) in strings.enumerated() {
      guard sqlite3_bind_text(ptr, Int32(i + 1), string, -1, transient) == SQLITE_OK else {
        throw failure()
      }
    }
    return try read(ptr)
  }
  private func query(_ sql: String, _ args: [String]) throws -> [String] {
    try statement(sql, args) { stmt in
      var values: [String] = []
      while true {
        switch sqlite3_step(stmt) {
        case SQLITE_ROW: values.append(String(cString: sqlite3_column_text(stmt, 0)))
        case SQLITE_DONE: return values
        default: throw failure()
        }
      }
    }
  }
  func rows() throws -> [String] { try query("SELECT doc FROM journal ORDER BY rowid", []) }
  func row(_ id: String) throws -> String? {
    try query("SELECT doc FROM journal WHERE id=?", [id]).first
  }
  func set(_ key: String, _ value: String) throws {
    try statement(
      "INSERT INTO settings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      [key, value]
    ) { if sqlite3_step($0) != SQLITE_DONE { throw failure() } }
  }
  func get(_ key: String) throws -> String? {
    try query("SELECT value FROM settings WHERE id=?", [key]).first
  }
  func save(id: String, previous: Int, doc: String) throws {
    let sql =
      previous == 0
      ? "INSERT INTO journal(id,revision,doc) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING"
      : "UPDATE journal SET revision=?,doc=? WHERE id=? AND revision=?"
    let args = previous == 0 ? [id, "1", doc] : [String(previous + 1), doc, id, String(previous)]
    try statement(sql, args) { stmt in
      guard sqlite3_step(stmt) == SQLITE_DONE else { throw failure() }
      guard sqlite3_changes(db) == 1 else { throw JournalFailure("这条记录已更新，请重新打开后保存。") }
    }
  }
}
