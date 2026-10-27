import AppKit
import Foundation
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let fm=FileManager.default
try fm.createDirectory(at: root.appendingPathComponent("icon.iconset"), withIntermediateDirectories: true)
func png(size:Int, logo:Bool)->Data {
 let rep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
 NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:rep)
 let scale=Double(size)/1024
 let transform=AffineTransform(scale:scale);(transform as NSAffineTransform).concat()
 NSColor(calibratedRed:0.14,green:0.37,blue:0.31,alpha:1).setFill()
 NSBezierPath(roundedRect:NSRect(x:0,y:0,width:1024,height:1024),xRadius:logo ? 220 : 0,yRadius:logo ? 220 : 0).fill()
 if logo {
  let leaf=NSBezierPath();leaf.move(to:NSPoint(x:290,y:290));leaf.curve(to:NSPoint(x:748,y:748),controlPoint1:NSPoint(x:290,y:570),controlPoint2:NSPoint(x:468,y:748));leaf.curve(to:NSPoint(x:290,y:290),controlPoint1:NSPoint(x:748,y:468),controlPoint2:NSPoint(x:570,y:290));leaf.close()
  NSColor(calibratedRed:0.76,green:0.88,blue:0.80,alpha:1).setFill();leaf.fill()
  NSColor(calibratedRed:0.14,green:0.37,blue:0.31,alpha:1).setStroke()
  let veins=NSBezierPath();veins.lineWidth=30;veins.lineCapStyle = .round;veins.move(to:NSPoint(x:275,y:270));veins.line(to:NSPoint(x:664,y:665));veins.move(to:NSPoint(x:428,y:428));veins.line(to:NSPoint(x:428,y:600));veins.move(to:NSPoint(x:520,y:520));veins.line(to:NSPoint(x:690,y:520));veins.stroke()
 }
 NSGraphicsContext.restoreGraphicsState();return rep.representation(using:.png,properties:[:])!
}
for size in [16,32,128,256,512] {
 try png(size:size,logo:true).write(to:root.appendingPathComponent("icon.iconset/icon_\(size)x\(size).png"))
 try png(size:size*2,logo:true).write(to:root.appendingPathComponent("icon.iconset/icon_\(size)x\(size)@2x.png"))
}
try png(size:128,logo:false).write(to:root.appendingPathComponent("connection-test.png"))
