// Local OCR with Apple's Vision framework (macOS only).
//
//   swift scripts/ocr/ocr.swift <image>...          # interpreted (slow start)
//   swiftc -O scripts/ocr/ocr.swift -o data/bin/ocr # compiled; `bun run ocr` does this for you
//
// Prints a JSON array with one entry per input path, in input order:
//   [{ "path", "lines": [{ "text", "confidence", "box": { "x", "y", "w", "h" } }], "error"? }]
// Boxes are normalized to 0–1 with the origin at the TOP-left. Lines are in reading order (top to
// bottom, then left to right). An image that can't be read gets "error" and no lines; the exit
// code is still 0, so one bad file doesn't lose the others.
import Foundation
import ImageIO
import Vision

struct Box: Codable { let x: Double; let y: Double; let w: Double; let h: Double }
struct Line: Codable { let text: String; let confidence: Double; let box: Box }
struct ImageResult: Codable { let path: String; let lines: [Line]; let error: String? }

func recognize(_ path: String) -> ImageResult {
  let url = URL(fileURLWithPath: path)
  guard
    let source = CGImageSourceCreateWithURL(url as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    return ImageResult(path: path, lines: [], error: "Could not load image")
  }

  // Respect EXIF orientation so rotated photos are read upright.
  var orientation = CGImagePropertyOrientation.up
  if let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
    let raw = props[kCGImagePropertyOrientation] as? UInt32,
    let o = CGImagePropertyOrientation(rawValue: raw)
  {
    orientation = o
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true

  let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
  do {
    try handler.perform([request])
  } catch {
    return ImageResult(path: path, lines: [], error: "Vision failed: \(error.localizedDescription)")
  }

  let lines: [Line] = (request.results ?? []).compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let bb = observation.boundingBox  // Vision's origin is bottom-left.
    return Line(
      text: candidate.string,
      confidence: Double(candidate.confidence),
      box: Box(
        x: Double(bb.minX), y: Double(1 - bb.maxY), w: Double(bb.width), h: Double(bb.height)))
  }
  let sorted = lines.sorted { a, b in
    let ca = a.box.y + a.box.h / 2
    let cb = b.box.y + b.box.h / 2
    // Same row when the vertical centres are within half a line height.
    if abs(ca - cb) < 0.5 * min(a.box.h, b.box.h) { return a.box.x < b.box.x }
    return ca < cb
  }
  return ImageResult(path: path, lines: sorted, error: nil)
}

let paths = Array(CommandLine.arguments.dropFirst())
if paths.isEmpty {
  FileHandle.standardError.write("usage: ocr <image>...\n".data(using: .utf8)!)
  exit(2)
}

let results = paths.map { path in autoreleasepool { recognize(path) } }
let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
FileHandle.standardOutput.write(try encoder.encode(results))
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
