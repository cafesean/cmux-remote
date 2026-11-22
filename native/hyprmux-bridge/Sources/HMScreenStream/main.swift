// hm-screen-stream: screen capture + H.264 helper.
//
// --probe: one-shot feasibility check on this Mac. Prints exactly one JSON line on stdout:
//   permissions (preflight only, never prompts), main-display identity, SCStream 420v capture,
//   VTCompressionSession H.264 encode (low-latency rate control, else RealTime), decode back through
//   VTDecompressionSession from the AVCC bytes + SPS/PPS (the path a remote viewer takes), and
//   whether a public API exposes the current system cursor image.
import AppKit
import ApplicationServices
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import ScreenStreamCore
import VideoToolbox

let probeFrames = 60
let forcedIDRs: Set<Int> = [0, 30]

func ms(_ a: UInt64, _ b: UInt64) -> Double { Double(b &- a) / 1_000_000 }
func mean(_ xs: [Double]) -> Double? { xs.isEmpty ? nil : xs.reduce(0, +) / Double(xs.count) }
func r2(_ x: Double?) -> Any { x.map { ($0 * 100).rounded() / 100 } ?? NSNull() }

// MARK: displays

func screenDescs() -> [ScreenDesc] {
  NSScreen.screens.compactMap { s in
    guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
    let f = s.frame
    return ScreenDesc(displayId: n.uint32Value,
                      appKitFrame: PointRect(x: f.origin.x, y: f.origin.y, w: f.width, h: f.height),
                      scale: Double(s.backingScaleFactor))
  }
}

// MARK: capture

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
  let onFrame: (CVPixelBuffer, Int) -> Void
  var callbacks = 0, complete = 0, idle = 0, dirtyFrames = 0
  var stopError: String?
  init(onFrame: @escaping (CVPixelBuffer, Int) -> Void) { self.onFrame = onFrame }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen else { return }
    callbacks += 1
    guard let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let a = atts.first, let raw = a[.status] as? Int, let status = SCFrameStatus(rawValue: raw) else { return }
    if status != .complete { idle += 1; return }
    let dirty = (a[.dirtyRects] as? [NSDictionary])?.count ?? 0
    if dirty > 0 { dirtyFrames += 1 }
    guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    complete += 1
    onFrame(pb, dirty)
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) { stopError = "\(error)" }
}

// MARK: encode

struct Encoded { var avcc: [UInt8]; var key: Bool; var encodeMs: Double }

final class Encoder {
  let session: VTCompressionSession
  let mode: String
  var out: [Encoded] = []
  var errors = 0, dropped = 0
  var formatDesc: CMFormatDescription?
  let lock = NSLock()

  init?(w: Int, h: Int, report: inout [String: Any]) {
    var s: VTCompressionSession?
    let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
    var st = VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
                                        encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                        outputCallback: nil, refcon: nil, compressionSessionOut: &s)
    var m = "lowLatencyRateControl"
    if st != noErr || s == nil {
      report["lowLatencyCreateStatus"] = Int(st)
      st = VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
                                      encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                      outputCallback: nil, refcon: nil, compressionSessionOut: &s)
      m = "realTime"
    }
    guard st == noErr, let sess = s else { report["encoderCreateStatus"] = Int(st); return nil }
    session = sess; mode = m
    var props: [String: Int32] = [:]
    func set(_ k: CFString, _ v: CFTypeRef, _ name: String) { props[name] = VTSessionSetProperty(sess, key: k, value: v) }
    set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue, "RealTime")
    set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse, "AllowFrameReordering")
    set(kVTCompressionPropertyKey_ProfileLevel,
        (m == "lowLatencyRateControl" ? kVTProfileLevel_H264_ConstrainedHigh_AutoLevel : kVTProfileLevel_H264_High_AutoLevel),
        "ProfileLevel")
    set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 60 as CFNumber, "MaxKeyFrameIntervalDuration")
    set(kVTCompressionPropertyKey_AverageBitRate, 8_000_000 as CFNumber, "AverageBitRate")
    set(kVTCompressionPropertyKey_ExpectedFrameRate, 60 as CFNumber, "ExpectedFrameRate")
    VTCompressionSessionPrepareToEncodeFrames(sess)
    var hw: CFTypeRef?
    _ = withUnsafeMutablePointer(to: &hw) {
      VTSessionCopyProperty(sess, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
                            allocator: nil, valueOut: UnsafeMutableRawPointer($0))
    }
    report["hardwareEncoder"] = (hw as? Bool) ?? NSNull()
    report["propertyStatus"] = props
  }

  func encode(_ pb: CVPixelBuffer, index: Int) {
    let t0 = DispatchTime.now().uptimeNanoseconds
    let pts = CMTime(value: CMTimeValue(index), timescale: 60)
    let fp: CFDictionary? = forcedIDRs.contains(index)
      ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let st = VTCompressionSessionEncodeFrame(session, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid,
                                             frameProperties: fp, infoFlagsOut: nil) { [self] status, _, sb in
      let t1 = DispatchTime.now().uptimeNanoseconds
      lock.lock(); defer { lock.unlock() }
      if status == noErr, sb == nil { dropped += 1; return } // encoder dropped the frame (real-time pacing)
      guard status == noErr, let sb, let bb = CMSampleBufferGetDataBuffer(sb) else { errors += 1; return }
      var notSync = false
      if let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]],
         let a = atts.first { notSync = (a[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false }
      let len = CMBlockBufferGetDataLength(bb)
      var bytes = [UInt8](repeating: 0, count: len)
      CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: len, destination: &bytes)
      if !notSync, formatDesc == nil { formatDesc = CMSampleBufferGetFormatDescription(sb) }
      out.append(Encoded(avcc: bytes, key: !notSync, encodeMs: ms(t0, t1)))
    }
    if st != noErr { lock.lock(); errors += 1; lock.unlock() }
  }

  func finish() { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid) }
}

// MARK: decode (from wire bytes: SPS/PPS + AVCC access units)

func parameterSets(_ fd: CMFormatDescription) -> [[UInt8]] {
  var count = 0
  CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                     parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
  return (0..<count).compactMap { i in
    var p: UnsafePointer<UInt8>?; var n = 0
    guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fd, parameterSetIndex: i, parameterSetPointerOut: &p,
                                                             parameterSetSizeOut: &n, parameterSetCountOut: nil,
                                                             nalUnitHeaderLengthOut: nil) == noErr, let p else { return nil }
    return Array(UnsafeBufferPointer(start: p, count: n))
  }
}

func decodeAll(_ frames: [Encoded], sets: [[UInt8]], report: inout [String: Any]) -> Int {
  guard sets.count >= 2 else { report["decodeError"] = "no SPS/PPS"; return 0 }
  var fd: CMFormatDescription?
  let st: OSStatus = sets[0].withUnsafeBufferPointer { s in
    sets[1].withUnsafeBufferPointer { p in
      let ptrs = [s.baseAddress!, p.baseAddress!]
      let sizes = [s.count, p.count]
      return CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: nil, parameterSetCount: 2,
                                                                 parameterSetPointers: ptrs, parameterSetSizes: sizes,
                                                                 nalUnitHeaderLength: 4, formatDescriptionOut: &fd)
    }
  }
  guard st == noErr, let fd else { report["decodeError"] = "format desc \(st)"; return 0 }
  let attrs = [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange] as CFDictionary
  var ds: VTDecompressionSession?
  let cst = VTDecompressionSessionCreate(allocator: nil, formatDescription: fd, decoderSpecification: nil,
                                         imageBufferAttributes: attrs, outputCallback: nil, decompressionSessionOut: &ds)
  guard cst == noErr, let ds else { report["decodeError"] = "session \(cst)"; return 0 }
  var ok = 0, decodeMs: [Double] = []
  for f in frames {
    var bb: CMBlockBuffer?
    let mem = UnsafeMutableRawPointer.allocate(byteCount: f.avcc.count, alignment: 1)
    f.avcc.withUnsafeBytes { mem.copyMemory(from: $0.baseAddress!, byteCount: f.avcc.count) }
    guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: mem, blockLength: f.avcc.count,
                                             blockAllocator: kCFAllocatorMalloc, customBlockSource: nil, offsetToData: 0,
                                             dataLength: f.avcc.count, flags: 0, blockBufferOut: &bb) == noErr, let bb else { continue }
    var sb: CMSampleBuffer?
    var size = f.avcc.count
    guard CMSampleBufferCreateReady(allocator: nil, dataBuffer: bb, formatDescription: fd, sampleCount: 1,
                                    sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1,
                                    sampleSizeArray: &size, sampleBufferOut: &sb) == noErr, let sb else { continue }
    let t0 = DispatchTime.now().uptimeNanoseconds
    var got = false
    let dst = VTDecompressionSessionDecodeFrame(ds, sampleBuffer: sb, flags: [], infoFlagsOut: nil) { status, _, img, _, _ in
      if status == noErr, img != nil { got = true }
    }
    VTDecompressionSessionWaitForAsynchronousFrames(ds)
    decodeMs.append(ms(t0, DispatchTime.now().uptimeNanoseconds))
    if dst == noErr, got { ok += 1 }
  }
  VTDecompressionSessionInvalidate(ds)
  report["meanDecodeMs"] = r2(mean(decodeMs))
  return ok
}

// MARK: synthetic 420v source (used when capture is unavailable or the screen is still)

func syntheticFrame(w: Int, h: Int, i: Int) -> CVPixelBuffer? {
  var pb: CVPixelBuffer?
  let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
  guard CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attrs, &pb) == kCVReturnSuccess,
        let pb else { return nil }
  CVPixelBufferLockBaseAddress(pb, [])
  defer { CVPixelBufferUnlockBaseAddress(pb, []) }
  for plane in 0..<2 {
    guard let base = CVPixelBufferGetBaseAddressOfPlane(pb, plane) else { continue }
    let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, plane)
    let ph = CVPixelBufferGetHeightOfPlane(pb, plane)
    let p = base.assumingMemoryBound(to: UInt8.self)
    for y in 0..<ph {
      let row = p + y * stride
      for x in 0..<stride { row[x] = plane == 0 ? UInt8(truncatingIfNeeded: x + y + i * 8) : 128 }
    }
  }
  return pb
}

// MARK: cursor

func cursorReport() -> [String: Any] {
  // NSCursor.currentSystem is the only public API documented to return the system cursor whatever app set it.
  guard let c = NSCursor.currentSystem else {
    return ["api": "NSCursor.currentSystem", "available": false, "v1": "showsCursor=true"]
  }
  let img = c.image
  let isArrow = img.tiffRepresentation == NSCursor.arrow.image.tiffRepresentation
  return ["api": "NSCursor.currentSystem", "available": true,
          "w": Double(img.size.width), "h": Double(img.size.height),
          "hotX": Double(c.hotSpot.x), "hotY": Double(c.hotSpot.y), "isArrow": isArrow,
          "v1": "candidate; confirm it tracks another app's I-beam/resize cursor, else showsCursor=true"]
}

// MARK: probe

func runProbe() async -> [String: Any] {
  var r: [String: Any] = ["probe": "hm-screen-stream", "version": 1]
  let os = ProcessInfo.processInfo.operatingSystemVersion
  r["macOS"] = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
  r["arch"] = { var u = utsname(); uname(&u); return withUnsafeBytes(of: &u.machine) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) } }()
  let screenOK = CGPreflightScreenCaptureAccess()
  let axOK = AXIsProcessTrusted()
  r["permissions"] = ["screenRecording": screenOK, "accessibility": axOK]

  let descs = screenDescs()
  r["displays"] = descs.count
  guard let g = DisplayMap.geometry(n: 1, screens: descs) else { r["error"] = "no display"; return r }
  r["display"] = ["n": 1, "displayId": g.displayId, "ptsW": g.ptsW, "ptsH": g.ptsH, "originX": g.originX,
                  "originY": g.originY, "nativeW": g.nativeW, "nativeH": g.nativeH, "scale": g.scale]
  let size = DisplayMap.encodeSize(requestW: nil, nativeW: g.nativeW, nativeH: g.nativeH)
  var encR: [String: Any] = ["encW": size.w, "encH": size.h]
  guard let enc = Encoder(w: size.w, h: size.h, report: &encR) else { r["encode"] = encR; return r }
  encR["mode"] = enc.mode

  var capR: [String: Any] = [:]
  var captured = 0
  let encodeQ = DispatchQueue(label: "encode")
  if !screenOK {
    capR["result"] = "skipped: Screen Recording not granted to this process (preflight false; not prompting)"
  } else {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      let ids = content.displays.map { $0.displayID }
      guard let idx = DisplayMap.captureIndex(displayId: g.displayId, candidates: ids) else {
        throw NSError(domain: "probe", code: 1, userInfo: [NSLocalizedDescriptionKey: "no SCDisplay for id \(g.displayId) in \(ids)"])
      }
      let disp = content.displays[idx]
      let cfg = SCStreamConfiguration()
      cfg.width = size.w; cfg.height = size.h
      cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60)
      cfg.queueDepth = 3
      cfg.showsCursor = false
      let sem = DispatchSemaphore(value: 0)
      let cap = Capture { pb, _ in
        encodeQ.sync {
          guard captured < probeFrames else { return }
          enc.encode(pb, index: captured); captured += 1
          if captured == probeFrames { sem.signal() }
        }
      }
      let stream = SCStream(filter: SCContentFilter(display: disp, excludingWindows: []), configuration: cfg, delegate: cap)
      try stream.addStreamOutput(cap, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture"))
      let t0 = DispatchTime.now().uptimeNanoseconds
      try await stream.startCapture()
      _ = await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
        DispatchQueue.global().async { _ = sem.wait(timeout: .now() + 4); k.resume() }
      }
      try? await stream.stopCapture()
      capR = ["result": "ok", "scDisplayMatchedById": true, "pixelFormat": "420v", "callbacks": cap.callbacks,
              "completeFrames": cap.complete, "idleFrames": cap.idle, "framesWithDirtyRects": cap.dirtyFrames,
              "windowMs": r2(ms(t0, DispatchTime.now().uptimeNanoseconds))]
      if let e = cap.stopError { capR["stopError"] = e }
    } catch {
      capR["result"] = "error: \(error.localizedDescription)"
    }
  }
  // A still screen yields few complete frames (0 fps by design): top up with synthetic 420v so encode/decode is measured.
  var synthetic = 0
  encodeQ.sync {
    while captured < probeFrames, let pb = syntheticFrame(w: size.w, h: size.h, i: captured) {
      enc.encode(pb, index: captured); captured += 1; synthetic += 1
    }
  }
  capR["capturedEncoded"] = probeFrames - synthetic
  capR["syntheticEncoded"] = synthetic
  r["capture"] = capR
  enc.finish()

  let frames = enc.out
  let idr = frames.filter(\.key), p = frames.filter { !$0.key }
  let nalIDR = frames.filter { AVCC.isIDR(AVCC.nalUnits($0.avcc) ?? []) }.count
  encR["frames"] = frames.count
  encR["errors"] = enc.errors
  encR["droppedByEncoder"] = enc.dropped
  encR["idrFrames"] = idr.count
  encR["idrByNalType5"] = nalIDR
  encR["meanEncodeMs"] = r2(mean(frames.map(\.encodeMs)))
  encR["meanIdrBytes"] = r2(mean(idr.map { Double($0.avcc.count) }))
  encR["meanPBytes"] = r2(mean(p.map { Double($0.avcc.count) }))
  r["encode"] = encR

  var decR: [String: Any] = [:]
  let sets = enc.formatDesc.map(parameterSets) ?? []
  decR["parameterSets"] = sets.count
  let ok = decodeAll(frames, sets: sets, report: &decR)
  decR["framesOk"] = ok
  decR["framesIn"] = frames.count
  r["decode"] = decR
  r["cursor"] = cursorReport()
  r["ok"] = enc.errors == 0 && frames.count + enc.dropped == probeFrames && ok == frames.count && idr.count >= 1
  return r
}

let args = CommandLine.arguments.dropFirst()
if args.contains("--probe") {
  _ = NSApplication.shared // NSScreen + NSCursor need an app object; no Dock icon (no activation policy change)
  let result = await runProbe()
  let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  exit((result["ok"] as? Bool) == true ? 0 : 1)
} else {
  FileHandle.standardError.write("usage: hm-screen-stream --probe\n".data(using: .utf8)!)
  exit(2)
}
