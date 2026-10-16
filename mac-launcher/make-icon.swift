// 맥 아이콘 규격(둥근 사각형 + 투명 여백)으로 1024px 아이콘 만들기
import AppKit
let src = NSImage(contentsOfFile: CommandLine.arguments[1])!
var r = CGRect(x: 0, y: 0, width: 1024, height: 1024)
let cg = src.cgImage(forProposedRect: &r, context: nil, hints: nil)!
let S: CGFloat = 1024, inset: CGFloat = 100
let ctx = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let rect = CGRect(x: inset, y: inset + 8, width: S - inset * 2, height: S - inset * 2)
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: NSColor.black.withAlphaComponent(0.28).cgColor)
let path = CGPath(roundedRect: rect, cornerWidth: rect.width * 0.225, cornerHeight: rect.width * 0.225, transform: nil)
ctx.addPath(path); ctx.setFillColor(NSColor.white.cgColor); ctx.fillPath()
ctx.setShadow(offset: .zero, blur: 0, color: nil)
ctx.addPath(path); ctx.clip()
ctx.interpolationQuality = .high
ctx.draw(cg, in: rect)
let out = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! out.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
