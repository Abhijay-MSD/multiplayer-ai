// Developer tool, macOS only: prints the text in each QR code found in an image (PNG, GIF, JPEG).
// Used by the tests to check that the codes Multiplayer AI draws can really be read. Not part of the app.
//   swift scripts/decode-qr.swift image.png
import CoreImage
import Foundation

guard CommandLine.arguments.count == 2,
      let image = CIImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])) else {
    FileHandle.standardError.write("usage: decode-qr <image>\n".data(using: .utf8)!)
    exit(2)
}
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
let found = (detector?.features(in: image) ?? []).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
if found.isEmpty { exit(1) }
for text in found { print(text) }
