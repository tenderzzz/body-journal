import Foundation

// One request on stdin; the archive key is never passed through process arguments.
do {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard let args = try JSONSerialization.jsonObject(with: input) as? [String: Any],
    let path = args["folder"] as? String, let key = args["code"] as? String,
    let local = args["local"] as? String
  else { throw JournalFailure("目录请求不完整") }
  let dir = try SyncDirectory(root: URL(fileURLWithPath: path), code: key)
  let result = try dir.perform(args, localRoot: URL(fileURLWithPath: local), byRecord: true)
  FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
} catch {
  FileHandle.standardError.write(Data(error.localizedDescription.utf8))
  exit(1)
}
