// Native side of the isolated two-device replay. All inputs and keys belong to temporary fixtures.
import Foundation

do {
  let args =
    try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile())
    as! [String: Any]
  let db = try PhoneDatabase(root: URL(fileURLWithPath: args["local"] as! String))
  var output: [String: Any] = [:]
  switch args["method"] as! String {
  case "personalBackup": try db.backupPersonal()
  case "personalGet": output["doc"] = (try db.get(args["name"] as! String) as Any?) ?? NSNull()
  case "personalSet": try db.set(args["name"] as! String, args["doc"] as! String)
  case "insights": output["doc"] = (try db.get("insights") as Any?) ?? NSNull()
  case "saveInsights": try db.set("insights", args["doc"] as! String)
  case "rows": output["rows"] = try db.rows()
  case "row": output["doc"] = (try db.row(args["id"] as! String)) as Any? ?? NSNull()
  case "save":
    try db.save(
      id: args["id"] as! String, previous: args["previous"] as! Int, doc: args["doc"] as! String)
  case "folder":
    let dir = try SyncDirectory(
      root: URL(fileURLWithPath: args["folder"] as! String), code: args["code"] as! String)
    output = try dir.perform(args["args"] as! [String: Any], localRoot: db.photos, byRecord: false)
  default: throw JournalFailure("unexpected test method")
  }
  FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output))
} catch {
  FileHandle.standardError.write(Data(error.localizedDescription.utf8))
  exit(1)
}
