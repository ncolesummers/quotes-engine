// Renders lines of black text on a white PNG, for the opt-in Vision OCR test.
//
//   swift test/fixtures/ocr/render-text.swift <out.png> "first line" "second line" ...
import AppKit
import Foundation

let args = CommandLine.arguments.dropFirst()
guard let out = args.first, args.count > 1 else {
  FileHandle.standardError.write("usage: render-text.swift <out.png> <line>...\n".data(using: .utf8)!)
  exit(2)
}
let lines = Array(args.dropFirst())

let width = 1200
let lineHeight = 120
let height = lineHeight * (lines.count + 1)
guard
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)
else { exit(1) }

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
let attrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 64),
  .foregroundColor: NSColor.black,
]
for (i, line) in lines.enumerated() {
  // AppKit's origin is bottom-left, so the first line is drawn highest.
  let y = height - lineHeight * (i + 1) - lineHeight / 4
  (line as NSString).draw(at: NSPoint(x: 60, y: y), withAttributes: attrs)
}
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: out))
