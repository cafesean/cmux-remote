// hm-screen-stream: screen capture + H.264 helper.
//
// default: long-lived helper (stdin JSON ops, stdout framed packets; see "helper mode" below).
// --decode-check: decode a captured helper stdout stream (smoke tool).
// --dry-input: helper mode, but input steps are logged to stderr instead of posted.
// --probe: one-shot feasibility check on this Mac. Prints exactly one JSON line on stdout:
//   permissions (preflight only, never prompts), main-display identity, SCStream 420v capture,
//   VTCompressionSession H.264 encode (low-latency rate control, else RealTime), decode back through
//   VTDecompressionSession from the AVCC bytes + SPS/PPS (the path a remote viewer takes), and
//   whether a public API exposes the current system cursor image.
import AppKit
import ApplicationServices
import Carbon
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


// MARK: input (CGEvent port of the JXA input; planning, epoch gate and held set in ScreenStreamCore.InputCore)

func postStep(_ s: EventStep, dry: Bool) -> Bool {
  if case let .pause(ms) = s { usleep(UInt32(ms) * 1000); return true }
  if dry { log("dry-input: \(s)"); return true }
  let src: CGEventSource? = nil
  var e: CGEvent?
  switch s {
  case let .mouse(kind, x, y, button, click, delta):
    e = CGEvent(mouseEventSource: src, mouseType: CGEventType(rawValue: kind.rawValue)!, mouseCursorPosition: CGPoint(x: x, y: y),
                mouseButton: CGMouseButton(rawValue: button.rawValue)!)
    if let click { e?.setIntegerValueField(.mouseEventClickState, value: Int64(click)) }
    if let delta {
      e?.setIntegerValueField(.mouseEventDeltaX, value: Int64(delta.dx.rounded()))
      e?.setIntegerValueField(.mouseEventDeltaY, value: Int64(delta.dy.rounded()))
    }
  case let .scroll(w1, w2):
    e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: w1, wheel2: w2, wheel3: 0)
  case let .key(code, down, flags):
    e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
    e?.flags = CGEventFlags(rawValue: flags)
  case let .unicode(units, down):
    e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
    units.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
  case let .keyText(code, down, flags, units):
    e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
    e?.flags = CGEventFlags(rawValue: flags)
    units.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
  case .pause: return true
  }
  guard let e else { return false }
  // HMX k110: marked, so this Mac's own key tap (hm-key-tap) lets remote-sent keys through (RD to the same Mac).
  e.setIntegerValueField(.eventSourceUserData, value: KeyCombo.postedMarker)
  e.post(tap: .cghidEventTap)
  return true
}

final class InputPoster {
  let q = DispatchQueue(label: "input")
  var engine = InputEngine()
  let dry: Bool
  var display: () -> DisplayGeometry? = { nil }
  var emit: ([String: Any]) -> Void = { _ in }
  var onPosted: (UInt32) -> Void = { _ in }
  var timer: DispatchSourceTimer?
  init(dry: Bool) { self.dry = dry }

  var env: InputEngine.Env {
    InputEngine.Env(now: nowUs, axTrusted: { [dry] in dry || AXIsProcessTrusted() }, secureInput: { IsSecureEventInputEnabled() },
                    display: display, post: { [dry] in postStep($0, dry: dry) })
  }

  func startWatchdog() {
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
    t.setEventHandler { [self] in
      for r in engine.watchdog(env) { log("input: safety up after 5 s held"); emit(r.json) }
    }
    t.resume(); timer = t
  }

  func gen(_ g: UInt32) { q.async { self.engine.setGen(g) } }

  /// op input: {gen, epoch, items:[{seq, t, ...}]} (an item may carry its own gen/epoch).
  func input(_ c: ControlOp) {
    let raw = (c.fields["items"] as? [[String: Any]]) ?? []
    let items = raw.compactMap { InputItem.from($0, gen: c.uint("gen"), epoch: c.uint("epoch")) }
    q.async { [self] in
      for r in engine.run(items, env) { emit(r.json) }
      onPosted(engine.lastPostedSeq)
    }
  }

  func release(_ c: ControlOp) {
    guard let e = c.uint("epoch") else { return }
    q.async { [self] in for r in engine.release(epoch: e, env) { emit(r.json) } }
  }
}

// MARK: helper mode (long-lived)
//
// stdin: JSON lines, ops exactly start|rate|grant|keyframe|time|input|release|stop.
// stdout: outer u32 BE length + one packet (42-byte header, ScreenStreamCore.Packet). stderr: log lines.
// The rate controller lives in the server; this process only applies what it is told.

func nowUs() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000 }
func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

final class Out {
  private let q = DispatchQueue(label: "stdout")
  func send(_ p: Packet) {
    let bytes = Framing.frame(p.encode())
    q.sync { FileHandle.standardOutput.write(Data(bytes)) }
  }
}

struct Pending { var gen: UInt32; var grantId: UInt32; var flags: PacketFlags; var rev: UInt32; var captureTs: UInt64; var charged: Bool }

final class LiveEncoder {
  let session: VTCompressionSession
  let w: Int, h: Int
  init?(w: Int, h: Int, kbps: Int, fps: Int) {
    var s: VTCompressionSession?
    let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
    var st = VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
                                        encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                        outputCallback: nil, refcon: nil, compressionSessionOut: &s)
    var lowLatency = true
    if st != noErr || s == nil {
      lowLatency = false
      st = VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: kCMVideoCodecType_H264,
                                      encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                      outputCallback: nil, refcon: nil, compressionSessionOut: &s)
    }
    guard st == noErr, let sess = s else { return nil }
    session = sess; self.w = w; self.h = h
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ProfileLevel,
                         value: lowLatency ? kVTProfileLevel_H264_ConstrainedHigh_AutoLevel : kVTProfileLevel_H264_High_AutoLevel)
    VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 60 as CFNumber)
    setRate(kbps: kbps, fps: fps)
    VTCompressionSessionPrepareToEncodeFrames(sess)
  }
  func setRate(kbps: Int, fps: Int) {
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: (kbps * 1000) as CFNumber)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
  }
  func encode(_ pb: CVPixelBuffer, ts: UInt64, idr: Bool, done: @escaping (OSStatus, CMSampleBuffer?) -> Void) {
    let fp: CFDictionary? = idr ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let st = VTCompressionSessionEncodeFrame(session, imageBuffer: pb, presentationTimeStamp: CMTime(value: CMTimeValue(ts), timescale: 1_000_000),
                                             duration: .invalid, frameProperties: fp, infoFlagsOut: nil) { status, _, sb in done(status, sb) }
    if st != noErr { done(st, nil) }
  }
  deinit { VTCompressionSessionInvalidate(session) }
}

final class Streamer: NSObject, SCStreamOutput, SCStreamDelegate {
  let q = DispatchQueue(label: "streamer")
  let out = Out()
  var gen: UInt32 = 0
  var geometry: DisplayGeometry?
  var encW = 0, encH = 0, kbps = 4000, fps = 30
  var ledger = GrantLedger()
  var revs = RevCounter()
  var seqs: [PacketType: UInt32] = [:]
  var retained: CVPixelBuffer?
  var retainedRev: UInt32 = 0, retainedTs: UInt64 = 0
  var lastCaptureTs: UInt64 = 0, lastChangeAt: UInt64 = 0
  var refineDone = true, needsIDR = true
  var droppedNoGrant = 0
  var encoder: LiveEncoder?
  var stream: SCStream?
  var timer: DispatchSourceTimer?
  var lastHeartbeat: UInt64 = 0
  let synthetic: Bool
  var synthIndex = 0
  let input: InputPoster
  var postedInput: UInt32 = 0
  init(synthetic: Bool, dryInput: Bool) {
    self.synthetic = synthetic
    input = InputPoster(dry: dryInput)
    super.init()
    input.display = { [weak self] in self?.q.sync { self?.geometry } ?? nil }
    input.emit = { [weak self] o in self?.q.async { self?.meta(o) } }
    input.onPosted = { [weak self] s in self?.q.async { self?.postedInput = s } }
    input.startWatchdog()
  }

  func nextSeq(_ t: PacketType) -> UInt32 { let s = seqs[t, default: 0]; seqs[t] = s &+ 1; return s }

  func meta(_ o: [String: Any], grantId: UInt32 = 0) {
    let d = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data()
    out.send(Packet(type: .meta, gen: gen, seq: nextSeq(.meta), captureTs: nowUs(), rev: revs.rev, grantId: grantId, payload: [UInt8](d)))
  }

  func handle(_ line: String) {
    guard let c = ControlOp.parse(line) else { log("ignored line"); return }
    q.async { [self] in
      switch c.op {
      case "start": start(c)
      case "rate": rate(c)
      case "grant":
        guard let g = c.uint("gen"), let id = c.uint("grantId") else { return }
        ledger.grant(gen: g, grantId: id, now: nowUs())
        maybeRefine()
      case "keyframe": keyframe(c)
      case "time":
        let recv = nowUs()
        out.send(Packet(type: .heartbeat, gen: gen, seq: nextSeq(.heartbeat), captureTs: lastCaptureTs, rev: revs.rev,
                        payload: TimeReply.encode(frameCaptureTs: lastCaptureTs, helperRecvTs: recv, helperSendTs: nowUs(),
                                                  timeId: c.uint("id") ?? 0)))
      case "input": input.input(c)
      case "release": input.release(c)
      case "stop": stopAll(); exit(0)
      default: break
      }
    }
  }

  func newGen(_ g: UInt32) {
    gen = g; ledger.reset(gen: g); seqs = [:]; needsIDR = true; input.gen(g)
  }

  func start(_ c: ControlOp) {
    stopCapture()
    newGen(c.uint("gen") ?? gen &+ 1)
    kbps = c.int("kbps") ?? kbps; fps = c.int("fps") ?? fps
    let descs = screenDescs()
    let want = c.uint("displayId")
    let n = want.flatMap { id in descs.firstIndex { $0.displayId == id }.map { $0 + 1 } } ?? (want == nil ? 1 : nil)
    guard let n, let g = DisplayMap.geometry(n: n, screens: descs) else { meta(["kind": "display_gone", "gen": gen]); return }
    geometry = g
    let s = StreamSize.resolve(w: c.int("w"), h: c.int("h"), nativeW: g.nativeW, nativeH: g.nativeH)
    encW = s.w; encH = s.h
    encoder = LiveEncoder(w: encW, h: encH, kbps: kbps, fps: fps)
    guard encoder != nil else { meta(["kind": "error", "code": "encoder_failed", "gen": gen]); return }
    meta(["kind": "started", "gen": gen, "displayId": g.displayId, "encW": encW, "encH": encH, "nativeW": g.nativeW,
          "nativeH": g.nativeH, "ptsW": g.ptsW, "ptsH": g.ptsH, "originX": g.originX, "originY": g.originY, "scale": g.scale,
          "kbps": kbps, "fps": fps])
    if timer == nil { startTimer() }
    if synthetic { return }
    let id = g.displayId, w = encW, h = encH, f = fps
    Task {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let idx = DisplayMap.captureIndex(displayId: id, candidates: content.displays.map { $0.displayID }) else {
          q.async { self.meta(["kind": "display_gone", "gen": self.gen]) }; return
        }
        let cfg = SCStreamConfiguration()
        cfg.width = w; cfg.height = h
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(f, 1)))
        cfg.queueDepth = 3
        cfg.showsCursor = false
        let st = SCStream(filter: SCContentFilter(display: content.displays[idx], excludingWindows: []), configuration: cfg, delegate: self)
        try st.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
        try await st.startCapture()
        q.async { self.stream = st }
      } catch {
        q.async { self.meta(["kind": "error", "code": "capture_failed", "gen": self.gen, "detail": error.localizedDescription]) }
      }
    }
  }

  func rate(_ c: ControlOp) {
    let g = c.uint("gen") ?? gen
    if let k = c.int("kbps") { kbps = k }
    if let f = c.int("fps") { fps = f }
    if g != gen {
      // A new gen may carry a new size: restart capture + encoder at it (never resize inside a gen).
      var f = c.fields; f["op"] = "start"; f["gen"] = g
      if f["displayId"] == nil, let id = geometry?.displayId { f["displayId"] = id }
      start(ControlOp.parse(String(data: try! JSONSerialization.data(withJSONObject: f), encoding: .utf8)!)!)
      return
    }
    if let w = c.int("w"), let h = c.int("h"), let geo = geometry {
      let s = StreamSize.resolve(w: w, h: h, nativeW: geo.nativeW, nativeH: geo.nativeH)
      if s.w != encW || s.h != encH { meta(["kind": "size_ignored", "gen": gen, "reason": "same_gen", "encW": encW, "encH": encH]) }
    }
    encoder?.setRate(kbps: kbps, fps: fps)
  }

  func keyframe(_ c: ControlOp) {
    if let g = c.uint("gen"), g != gen { return }
    if c.bool("emergency"), let id = c.uint("grantId") {
      guard ledger.reserveEmergency(gen: gen, grantId: id) else { meta(["kind": "emergency_busy", "gen": gen, "grantId": id]); return }
      if let pb = retained, let e = ledger.takeEmergency() {
        encodeFrame(pb, Pending(gen: gen, grantId: e.grantId, flags: [.snapshot, .free], rev: retainedRev, captureTs: retainedTs, charged: false), idr: true)
      } else { needsIDR = true }
      return
    }
    needsIDR = true
    if let pb = retained, let g = ledger.take(now: nowUs()) {
      encodeFrame(pb, Pending(gen: gen, grantId: g.grantId, flags: [.snapshot], rev: retainedRev, captureTs: retainedTs, charged: true), idr: true)
    }
  }

  func maybeRefine() {
    guard !refineDone, let pb = retained, nowUs() &- lastChangeAt >= 500_000, ledger.available,
          let g = ledger.take(now: nowUs()) else { return }
    refineDone = true
    encodeFrame(pb, Pending(gen: gen, grantId: g.grantId, flags: [.refine, .snapshot], rev: retainedRev, captureTs: retainedTs, charged: true), idr: true)
  }

  func startTimer() {
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    t.setEventHandler { [self] in
      let now = nowUs()
      for g in ledger.expire(now: now) { meta(["kind": "skipped", "gen": g.gen, "grantId": g.grantId], grantId: g.grantId) }
      maybeRefine()
      if synthetic && synthIndex == 0 { feedSynthetic() } // synthetic source: one change, then still
      if now &- lastHeartbeat >= 1_000_000 {
        lastHeartbeat = now
        out.send(Packet(type: .heartbeat, gen: gen, seq: nextSeq(.heartbeat), captureTs: lastCaptureTs, rev: revs.rev,
                        payload: Heartbeat.encode(lastCaptureTs: lastCaptureTs, latestRev: revs.rev)))
      }
    }
    t.resume(); timer = t
  }

  func feedSynthetic() {
    guard let pb = syntheticFrame(w: encW, h: encH, i: synthIndex) else { return }
    synthIndex += 1
    frame(pb, complete: true, dirty: 1)
  }

  // SCStream output (on q)
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen,
          let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let a = atts.first, let raw = a[.status] as? Int, let status = SCFrameStatus(rawValue: raw) else { return }
    let dirty = (a[.dirtyRects] as? [NSDictionary])?.count ?? 0
    guard status == .complete, let pb = CMSampleBufferGetImageBuffer(sb) else { _ = revs.observe(complete: false, dirtyRects: dirty); return }
    frame(pb, complete: true, dirty: dirty)
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    q.async { self.meta(["kind": "error", "code": "capture_stopped", "gen": self.gen, "detail": "\(error)"]) }
  }

  func frame(_ pb: CVPixelBuffer, complete: Bool, dirty: Int) {
    guard revs.observe(complete: complete, dirtyRects: dirty) else { return } // idle / no dirty rects: encode nothing
    let ts = nowUs()
    retained = pb; retainedRev = revs.rev; retainedTs = ts
    lastCaptureTs = ts; lastChangeAt = ts; refineDone = false
    guard let g = ledger.take(now: ts) else { droppedNoGrant += 1; return } // no grant: dropped before encode
    encodeFrame(pb, Pending(gen: gen, grantId: g.grantId, flags: [], rev: revs.rev, captureTs: ts, charged: true), idr: needsIDR)
  }

  func encodeFrame(_ pb: CVPixelBuffer, _ p: Pending, idr: Bool) {
    guard let enc = encoder else { return }
    if idr { needsIDR = false }
    let k = kbps
    enc.encode(pb, ts: p.captureTs, idr: idr) { [self] status, sb in
      let done = nowUs()
      q.async { [self] in
        guard p.gen == gen else { return }
        guard status == noErr, let sb, let bb = CMSampleBufferGetDataBuffer(sb) else {
          if p.charged { meta(["kind": "skipped", "gen": p.gen, "grantId": p.grantId, "reason": "encoder_drop"], grantId: p.grantId) }
          if idr { needsIDR = true }
          return
        }
        var notSync = false
        if let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]],
           let a = atts.first { notSync = (a[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false }
        let len = CMBlockBufferGetDataLength(bb)
        var nals = [UInt8](repeating: 0, count: len)
        CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: len, destination: &nals)
        var flags = p.flags
        var payload = nals
        if !notSync, let fd = CMSampleBufferGetFormatDescription(sb) {
          let sets = parameterSets(fd)
          let avcC = AvcC.build(sps: sets.filter { ($0.first ?? 0) & 0x1F == 7 }, pps: sets.filter { ($0.first ?? 0) & 0x1F == 8 })
          payload = VideoPayload.withConfig(avcC: avcC, nals: nals)
          flags.insert([.keyframe, .config])
          if IdrBudget.over(bytes: payload.count, kbps: k) {
            meta(["kind": "idr_over_budget", "gen": p.gen, "grantId": p.grantId, "bytes": payload.count, "kbps": k,
                  "encW": encW, "encH": encH], grantId: p.grantId)
          }
        } else {
          flags.subtract([.snapshot, .refine, .free])
        }
        if PacketHeader.size + payload.count > PacketHeader.maxPacket { needsIDR = true; return }
        out.send(Packet(type: .video, flags: flags, gen: p.gen, seq: nextSeq(.video), captureTs: p.captureTs, encodeDoneTs: done,
                        postedInput: postedInput, rev: p.rev, grantId: p.grantId, payload: payload))
      }
    }
  }

  func stopCapture() {
    if let s = stream { stream = nil; Task { try? await s.stopCapture() } }
  }
  func stopAll() { stopCapture(); encoder = nil; timer?.cancel(); timer = nil }
}

func runHelper(synthetic: Bool, dryInput: Bool) -> Never {
  _ = NSApplication.shared
  let s = Streamer(synthetic: synthetic, dryInput: dryInput)
  Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) { if !line.isEmpty { s.handle(line) } }
    s.q.sync { s.stopAll() }
    exit(0)
  }
  dispatchMain()
}

// MARK: --decode-check: framed packets on stdin -> decode every video packet with the probe's decoder path

func runDecodeCheck() -> Never {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  var d = Deframer()
  var r: [String: Any] = [:]
  do {
    let bodies = try d.push([UInt8](data))
    let pkts = try bodies.map { try Packet.decode($0) }
    var sets: [[UInt8]] = [], frames: [Encoded] = [], videos: [[String: Any]] = []
    var types: [String: Int] = [:]
    for p in pkts {
      types["\(p.type.rawValue)", default: 0] += 1
      if p.type == .meta { videos.append(["meta": String(decoding: p.payload, as: UTF8.self)]) }
      guard p.type == .video, let s = VideoPayload.split(p.payload, config: p.flags.contains(.config)) else { continue }
      if let a = s.avcC, let ps = AvcC.parameterSets(a), sets.isEmpty { sets = ps.sps + ps.pps }
      frames.append(Encoded(avcc: s.nals, key: p.flags.contains(.keyframe), encodeMs: 0))
      videos.append(["seq": p.seq, "gen": p.gen, "grantId": p.grantId, "rev": p.rev, "flags": Int(p.flags.rawValue),
                     "bytes": p.payload.count, "idrNal": AVCC.isIDR(AVCC.nalUnits(s.nals) ?? [])])
    }
    var dec: [String: Any] = [:]
    let ok = decodeAll(frames, sets: sets, report: &dec)
    r = ["packets": pkts.count, "types": types, "video": videos, "decodedOk": ok, "decodeIn": frames.count, "decode": dec,
         "trailingBytes": d.buffered, "ok": ok == frames.count && ok > 0]
  } catch { r = ["error": "\(error)", "ok": false] }
  print(String(data: try! JSONSerialization.data(withJSONObject: r, options: [.sortedKeys]), encoding: .utf8)!)
  exit((r["ok"] as? Bool) == true ? 0 : 1)
}

let args = CommandLine.arguments.dropFirst()
if args.contains("--probe") {
  _ = NSApplication.shared // NSScreen + NSCursor need an app object; no Dock icon (no activation policy change)
  let result = await runProbe()
  let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  exit((result["ok"] as? Bool) == true ? 0 : 1)
} else if args.contains("--decode-check") {
  runDecodeCheck()
} else {
  runHelper(synthetic: args.contains("--synthetic"), dryInput: args.contains("--dry-input"))
}
