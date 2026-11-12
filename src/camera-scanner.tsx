import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Flashlight,
  FlashlightOff,
  Plus,
  RefreshCw,
  ShieldCheck,
  SwitchCamera,
  Undo2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
} from 'lucide-react';
import {
  prepareZXingModule,
  readBarcodes,
  type ReaderOptions,
} from 'zxing-wasm/reader';
import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

interface ExtendedMediaTrackCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  focusMode?: string[];
  zoom?: { min: number; max: number; step: number };
}

interface ExtendedMediaTrackConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean;
  focusMode?: string;
  zoom?: number;
}

const BARCODE_READER_OPTIONS: ReaderOptions = {
  formats: ['EAN13'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: false,
  tryDownscale: true,
  minLineCount: 3,
  maxNumberOfSymbols: 4,
  eanAddOnSymbol: 'Ignore',
};

let zxingPrepared = false;

function ensureZXingPrepared() {
  if (zxingPrepared) return;
  zxingPrepared = true;
  prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => {
        if (path.endsWith('.wasm')) {
          return zxingReaderWasmUrl;
        }
        return prefix + path;
      },
    },
    fireImmediately: true,
  });
}

let sharedAudioContext: AudioContext | null = null;

function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  );
}

/**
 * Unlock Web Audio synchronously inside a user tap gesture (required on iOS Safari).
 */
export function unlockScanAudio() {
  try {
    const AudioCtx = getAudioContextConstructor();
    if (!AudioCtx) return;
    if (!sharedAudioContext) {
      sharedAudioContext = new AudioCtx();
    }
    if (sharedAudioContext.state === 'suspended') {
      void sharedAudioContext.resume();
    }
  } catch {
    // Ignore audio errors on unsupported devices
  }
}

function playScanBeep() {
  try {
    const AudioCtx = getAudioContextConstructor();
    if (!AudioCtx) return;
    if (!sharedAudioContext) {
      sharedAudioContext = new AudioCtx();
    }
    const ctx = sharedAudioContext;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1046.5, now);
    osc.frequency.setValueAtTime(1318.5, now + 0.045);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.13);
  } catch {
    // Ignore audio playback errors
  }
}

function getCameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Camera permission was denied. Allow camera access in your browser settings and tap Retry.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No camera was found on this device.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Camera is busy or unavailable. Close other apps using the camera and tap Retry.';
      case 'SecurityError':
        return 'Camera access is blocked by browser security settings.';
      default:
        return error.message || 'Unable to start the camera.';
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unable to start the camera.';
}

function computeReticleCrop(
  video: HTMLVideoElement,
  reticle: HTMLDivElement | null,
): { sx: number; sy: number; sw: number; sh: number } {
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  if (reticle) {
    const videoRect = video.getBoundingClientRect();
    const reticleRect = reticle.getBoundingClientRect();
    if (
      videoRect.width > 0 &&
      videoRect.height > 0 &&
      reticleRect.width > 0 &&
      reticleRect.height > 0
    ) {
      const scale = Math.max(videoRect.width / vw, videoRect.height / vh);
      const dispW = vw * scale;
      const dispH = vh * scale;
      const offsetX = (videoRect.width - dispW) / 2;
      const offsetY = (videoRect.height - dispH) / 2;

      // Small 12px screen padding preserves barcode left/right quiet zones
      const pad = 12;
      const rx = reticleRect.left - pad - videoRect.left - offsetX;
      const ry = reticleRect.top - pad - videoRect.top - offsetY;
      const rw = reticleRect.width + pad * 2;
      const rh = reticleRect.height + pad * 2;

      const sx = Math.max(0, Math.floor(rx / scale));
      const sy = Math.max(0, Math.floor(ry / scale));
      const sw = Math.min(vw - sx, Math.ceil(rw / scale));
      const sh = Math.min(vh - sy, Math.ceil(rh / scale));

      if (sw >= 40 && sh >= 40) {
        return { sx, sy, sw, sh };
      }
    }
  }

  return {
    sx: Math.round(vw * 0.1),
    sy: Math.round(vh * 0.3),
    sw: Math.round(vw * 0.8),
    sh: Math.round(vh * 0.4),
  };
}

type CameraScannerModalProps = {
  open: boolean;
  onClose: () => void;
  onScan: (barcode: string) => boolean;
  onUndo: () => void;
  isValidBarcode: (barcode: string) => boolean;
  scannedBarcodes: Set<string>;
  scanCount: number;
  totalWeight: number;
  lastMessage: string;
  lastMessageType: 'ready' | 'success' | 'error';
};

export function CameraScannerModal({
  open,
  onClose,
  onScan,
  onUndo,
  isValidBarcode,
  scannedBarcodes,
  scanCount,
  totalWeight,
  lastMessage,
  lastMessageType,
}: CameraScannerModalProps) {
  const [status, setStatus] = useState<'starting' | 'ready' | 'error'>(
    'starting',
  );
  const [errorMsg, setErrorMsg] = useState('');
  const [hint, setHint] = useState('');
  const [duplicateCandidate, setDuplicateCandidate] = useState('');
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoomRange, setZoomRange] = useState<{
    min: number;
    max: number;
    step: number;
  } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [scanFlash, setScanFlash] = useState(false);
  const [restartToken, setRestartToken] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const reticleRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onScanRef = useRef(onScan);
  const isValidRef = useRef(isValidBarcode);
  const scannedBarcodesRef = useRef(scannedBarcodes);
  const allowDuplicatesRef = useRef(allowDuplicates);
  const soundEnabledRef = useRef(soundEnabled);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    isValidRef.current = isValidBarcode;
  }, [isValidBarcode]);

  useEffect(() => {
    scannedBarcodesRef.current = scannedBarcodes;
  }, [scannedBarcodes]);

  useEffect(() => {
    allowDuplicatesRef.current = allowDuplicates;
  }, [allowDuplicates]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  const lastAcceptedAtRef = useRef<number>(0);
  const lastAcceptedCodeRef = useRef<string>('');
  const lastSeenByCodeRef = useRef<Map<string, number>>(new Map());
  const lastAcceptedByCodeRef = useRef<Map<string, number>>(new Map());
  const currentDeviceIdRef = useRef<string>('');

  const triggerAcceptedFeedback = useCallback(() => {
    if (soundEnabledRef.current) {
      playScanBeep();
    }
    navigator.vibrate?.(60);
    setScanFlash(true);
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = setTimeout(() => {
      setScanFlash(false);
    }, 550);
  }, []);

  const stopCamera = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setTorchOn(false);
    setTorchSupported(false);
    setZoomRange(null);
    setZoomed(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      stopCamera();
      lastAcceptedAtRef.current = 0;
      lastAcceptedCodeRef.current = '';
      lastSeenByCodeRef.current.clear();
      lastAcceptedByCodeRef.current.clear();
      setHint('');
      setDuplicateCandidate('');
      return;
    }

    let cancelled = false;

    const acquireStream = async (): Promise<MediaStream> => {
      const baseVideo: MediaTrackConstraints = selectedDeviceId
        ? {
            deviceId: { exact: selectedDeviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          };

      try {
        return await navigator.mediaDevices.getUserMedia({
          video: baseVideo,
          audio: false,
        });
      } catch (err) {
        if (
          err instanceof DOMException &&
          (err.name === 'OverconstrainedError' ||
            err.name === 'ConstraintNotSatisfiedError')
        ) {
          try {
            return await navigator.mediaDevices.getUserMedia({
              video: selectedDeviceId
                ? { deviceId: { exact: selectedDeviceId } }
                : { facingMode: { ideal: 'environment' } },
              audio: false,
            });
          } catch {
            return await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
          }
        }
        throw err;
      }
    };

    const scanNextFrame = async () => {
      if (cancelled) return;

      const video = videoRef.current;
      if (
        video &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        // Strictly crop to the visible reticle box so moving past adjacent
        // or previous barcodes outside the frame never triggers accidental scans.
        const { sx, sy, sw, sh } = computeReticleCrop(
          video,
          reticleRef.current,
        );

        const maxDim = Math.max(sw, sh);
        const scale = maxDim > 1280 ? 1280 / maxDim : 1;
        const dw = Math.max(1, Math.round(sw * scale));
        const dh = Math.max(1, Math.round(sh * scale));

        if (!canvasRef.current) {
          canvasRef.current = document.createElement('canvas');
        }
        const canvas = canvasRef.current;
        if (canvas.width !== dw || canvas.height !== dh) {
          canvas.width = dw;
          canvas.height = dh;
        }

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
          const imageData = ctx.getImageData(0, 0, dw, dh);
          try {
            const results = await readBarcodes(
              imageData,
              BARCODE_READER_OPTIONS,
            );
            if (cancelled) return;

            if (results.length > 0) {
              const validMatch = results.find(
                (r) => r.isValid && isValidRef.current(r.text),
              );

              if (validMatch) {
                const code = validMatch.text.trim();
                const now = Date.now();
                const sinceLastAccept = now - lastAcceptedAtRef.current;
                const previousSeenForCode =
                  lastSeenByCodeRef.current.get(code) ?? 0;
                const previousAcceptForCode =
                  lastAcceptedByCodeRef.current.get(code) ?? 0;
                const gapSinceCodeSeen = now - previousSeenForCode;
                const sinceCodeAccepted = now - previousAcceptForCode;

                lastSeenByCodeRef.current.set(code, now);

                if (
                  !allowDuplicatesRef.current &&
                  scannedBarcodesRef.current.has(code)
                ) {
                  // Prevent double-scanning an already-added barcode while moving.
                  // Show a manual "+ Add again" pill only after 1.4s or if returning to an older code.
                  if (
                    code !== lastAcceptedCodeRef.current ||
                    sinceLastAccept >= 1400
                  ) {
                    setDuplicateCandidate(code);
                    if (dupTimerRef.current) clearTimeout(dupTimerRef.current);
                    dupTimerRef.current = setTimeout(() => {
                      setDuplicateCandidate('');
                    }, 1500);
                  }
                } else {
                  const shouldAccept = allowDuplicatesRef.current
                    ? gapSinceCodeSeen >= 1500 &&
                      sinceCodeAccepted >= 2500 &&
                      sinceLastAccept >= 500
                    : sinceLastAccept >= 450;

                  if (shouldAccept) {
                    lastAcceptedAtRef.current = now;
                    lastAcceptedCodeRef.current = code;
                    lastAcceptedByCodeRef.current.set(code, now);
                    const added = onScanRef.current(code);
                    if (added) {
                      setHint('');
                      setDuplicateCandidate('');
                      triggerAcceptedFeedback();
                    }
                  }
                }
              } else {
                const nonTwo = results.find((r) => r.isValid && r.text);
                if (nonTwo) {
                  setHint(
                    `Detected ${nonTwo.text} — aim at the barcode starting with 2`,
                  );
                  if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
                  hintTimerRef.current = setTimeout(() => setHint(''), 1800);
                }
              }
            }
          } catch {
            // Skip malformed frame and continue scanning
          }
        }
      }

      if (!cancelled) {
        timerRef.current = setTimeout(() => {
          void scanNextFrame();
        }, 100);
      }
    };

    const start = async () => {
      setStatus('starting');
      setErrorMsg('');

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setErrorMsg(
          'Camera scanning requires a secure HTTPS connection (or localhost).',
        );
        setStatus('error');
        return;
      }

      try {
        ensureZXingPrepared();
        const stream = await acquireStream();
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
        if (cancelled) {
          stopCamera();
          return;
        }

        const track = stream.getVideoTracks()[0];
        if (track) {
          currentDeviceIdRef.current = track.getSettings?.().deviceId ?? '';
          const capabilities = track.getCapabilities?.() as
            | ExtendedMediaTrackCapabilities
            | undefined;

          if (capabilities?.focusMode?.includes('continuous')) {
            try {
              await track.applyConstraints({
                advanced: [
                  {
                    focusMode: 'continuous',
                  } as ExtendedMediaTrackConstraintSet,
                ],
              });
            } catch {
              // Ignore devices that report focusMode but disallow updating it
            }
          }

          setTorchSupported(Boolean(capabilities?.torch));

          if (capabilities?.zoom && capabilities.zoom.max >= 1.5) {
            setZoomRange(capabilities.zoom);
          } else {
            setZoomRange(null);
          }
        }

        if (navigator.mediaDevices.enumerateDevices) {
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            if (!cancelled) {
              const videoInputs = devices.filter(
                (device) => device.kind === 'videoinput',
              );
              setCameras(videoInputs);
            }
          } catch {
            // Ignore enumerateDevices failure
          }
        }

        setStatus('ready');
        timerRef.current = setTimeout(() => {
          void scanNextFrame();
        }, 120);
      } catch (err) {
        if (!cancelled) {
          stopCamera();
          setErrorMsg(getCameraErrorMessage(err));
          setStatus('error');
        }
      }
    };

    void start();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopCamera();
      } else if (document.visibilityState === 'visible' && open) {
        setRestartToken((value) => value + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (dupTimerRef.current) clearTimeout(dupTimerRef.current);
      stopCamera();
    };
  }, [
    open,
    selectedDeviceId,
    restartToken,
    stopCamera,
    triggerAcceptedFeedback,
  ]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !torchSupported) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as ExtendedMediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      // Ignore torch errors on unsupported firmware
    }
  };

  const toggleZoom = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !zoomRange) return;
    const nextZoomed = !zoomed;
    const targetZoom = nextZoomed
      ? Math.min(2, zoomRange.max)
      : Math.max(1, zoomRange.min);
    try {
      await track.applyConstraints({
        advanced: [{ zoom: targetZoom } as ExtendedMediaTrackConstraintSet],
      });
      setZoomed(nextZoomed);
    } catch {
      // Ignore zoom errors
    }
  };

  const switchCamera = () => {
    if (cameras.length < 2) return;
    const activeId = selectedDeviceId || currentDeviceIdRef.current;
    const currentIndex = cameras.findIndex((cam) => cam.deviceId === activeId);
    const nextIndex =
      currentIndex >= 0 ? (currentIndex + 1) % cameras.length : 0;
    setSelectedDeviceId(cameras[nextIndex].deviceId);
  };

  const addDuplicateManually = () => {
    if (!duplicateCandidate) return;
    const code = duplicateCandidate;
    const added = onScanRef.current(code);
    if (added) {
      const now = Date.now();
      lastAcceptedAtRef.current = now;
      lastAcceptedCodeRef.current = code;
      lastAcceptedByCodeRef.current.set(code, now);
      setDuplicateCandidate('');
      setHint('');
      triggerAcceptedFeedback();
    }
  };

  const handleUndo = () => {
    // Brief pause so the just-undone barcode isn't immediately re-scanned
    lastAcceptedAtRef.current = Date.now() + 900;
    setDuplicateCandidate('');
    onUndo();
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Camera barcode scanner"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 sm:p-6"
    >
      <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#190c08] text-white sm:h-auto sm:max-h-[90dvh] sm:max-w-lg sm:rounded-[28px] sm:border sm:border-white/15 sm:shadow-2xl">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#5a2417] text-[#f5d5c3]">
              <Camera size={17} />
            </span>
            <div>
              <p className="text-sm font-black leading-tight">Camera scanner</p>
              <p className="text-[11px] font-medium text-[#cfb3a5]">
                Aim inside box · 2-Barcode
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {zoomRange && (
              <button
                type="button"
                onClick={() => void toggleZoom()}
                className={`inline-flex h-9 items-center gap-1 rounded-xl px-2.5 text-xs font-bold transition ${
                  zoomed
                    ? 'bg-[#d98d64] text-[#29150f]'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
                aria-label={zoomed ? 'Reset zoom to 1x' : 'Zoom in 2x'}
                title={zoomed ? '1x zoom' : '2x zoom for small barcodes'}
              >
                <ZoomIn size={15} />
                <span>{zoomed ? '2x' : '1x'}</span>
              </button>
            )}
            {torchSupported && (
              <button
                type="button"
                onClick={() => void toggleTorch()}
                className={`grid h-9 w-9 place-items-center rounded-xl transition ${
                  torchOn
                    ? 'bg-[#fbbf24] text-[#29150f]'
                    : 'bg-white/10 text-white hover:bg-white/20'
                }`}
                aria-label={
                  torchOn ? 'Turn off flashlight' : 'Turn on flashlight'
                }
                title={torchOn ? 'Turn off flash' : 'Turn on flash'}
              >
                {torchOn ? (
                  <Flashlight size={17} />
                ) : (
                  <FlashlightOff size={17} />
                )}
              </button>
            )}
            {cameras.length > 1 && (
              <button
                type="button"
                onClick={switchCamera}
                className="grid h-9 w-9 place-items-center rounded-xl bg-white/10 text-white transition hover:bg-white/20"
                aria-label="Switch camera lens"
                title="Switch camera"
              >
                <SwitchCamera size={17} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setSoundEnabled((enabled) => !enabled)}
              className="grid h-9 w-9 place-items-center rounded-xl bg-white/10 text-white transition hover:bg-white/20"
              aria-label={soundEnabled ? 'Mute scan beep' : 'Enable scan beep'}
              title={soundEnabled ? 'Sound on' : 'Sound muted'}
            >
              {soundEnabled ? <Volume2 size={17} /> : <VolumeX size={17} />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="grid h-9 w-9 place-items-center rounded-xl bg-white/15 text-white transition hover:bg-white/25"
              aria-label="Close camera scanner"
              title="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Camera viewfinder */}
        <div className="relative flex-1 overflow-hidden bg-black sm:aspect-[4/3] sm:flex-none">
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="h-full w-full object-cover"
          />

          {/* Aiming reticle overlay */}
          {status === 'ready' && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-6">
              <div
                ref={reticleRef}
                className={`relative h-36 w-full max-w-[320px] rounded-2xl border-2 transition-colors duration-200 ${
                  scanFlash
                    ? 'border-[#4ade80] bg-[#4ade80]/15 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]'
                    : duplicateCandidate
                      ? 'border-[#fbbf24] shadow-[0_0_0_9999px_rgba(0,0,0,0.58)]'
                      : 'border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.58)]'
                }`}
              >
                <span className="absolute -top-0.5 -left-0.5 h-6 w-6 rounded-tl-2xl border-t-4 border-l-4 border-[#f2a679]" />
                <span className="absolute -top-0.5 -right-0.5 h-6 w-6 rounded-tr-2xl border-t-4 border-r-4 border-[#f2a679]" />
                <span className="absolute -bottom-0.5 -left-0.5 h-6 w-6 rounded-bl-2xl border-b-4 border-l-4 border-[#f2a679]" />
                <span className="absolute -right-0.5 -bottom-0.5 h-6 w-6 rounded-br-2xl border-r-4 border-b-4 border-[#f2a679]" />
                <div
                  className={`absolute inset-x-4 top-1/2 h-0.5 -translate-y-1/2 rounded-full transition-colors ${
                    scanFlash
                      ? 'bg-[#4ade80] shadow-[0_0_12px_#4ade80]'
                      : duplicateCandidate
                        ? 'bg-[#fbbf24] shadow-[0_0_8px_#fbbf24]'
                        : 'bg-[#f87171]/80 shadow-[0_0_8px_#f87171]'
                  }`}
                />
              </div>

              {duplicateCandidate ? (
                <div className="pointer-events-auto mt-4 flex items-center gap-2 rounded-full border border-[#fbbf24]/50 bg-[#23110b]/95 py-1 pr-1.5 pl-3.5 text-xs font-bold text-[#fde68a] shadow-lg backdrop-blur-xs">
                  <span>Already scanned</span>
                  <button
                    type="button"
                    onClick={addDuplicateManually}
                    className="inline-flex items-center gap-1 rounded-full bg-[#fbbf24] px-2.5 py-1 text-xs font-black text-[#29150f] transition active:scale-95"
                  >
                    <Plus size={13} /> Add again
                  </button>
                </div>
              ) : (
                <p className="mt-4 rounded-full bg-black/70 px-3.5 py-1.5 text-center text-xs font-semibold text-white/90 backdrop-blur-xs">
                  {hint || 'Place barcode inside the box · 10–20 cm away'}
                </p>
              )}
            </div>
          )}

          {status === 'starting' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#190c08]/90 p-6 text-center">
              <Camera className="animate-pulse text-[#f2a679]" size={36} />
              <p className="text-sm font-bold text-white">Starting camera…</p>
              <p className="max-w-xs text-xs text-[#cfb3a5]">
                If prompted, tap Allow to use your phone&apos;s camera.
              </p>
            </div>
          )}

          {status === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#190c08]/95 p-6 text-center">
              <Camera className="text-[#f87171]" size={38} />
              <p className="max-w-xs text-sm font-semibold leading-6 text-[#fdd5ce]">
                {errorMsg}
              </p>
              <button
                type="button"
                onClick={() => setRestartToken((value) => value + 1)}
                className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-black text-[#29150f] transition hover:bg-[#f5ede6]"
              >
                <RefreshCw size={16} /> Retry
              </button>
            </div>
          )}
        </div>

        {/* Bottom feedback & controls */}
        <div className="border-t border-white/10 bg-[#23110b] px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setAllowDuplicates((prev) => !prev);
                setDuplicateCandidate('');
              }}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold transition ${
                !allowDuplicates
                  ? 'border-[#34d399]/35 bg-[#064e3b]/60 text-[#6ee7b7]'
                  : 'border-white/15 bg-white/10 text-[#f5d5c3]'
              }`}
              title="Toggle whether the same barcode can be scanned repeatedly without tapping Add again"
            >
              <ShieldCheck size={13} />
              <span>
                {!allowDuplicates
                  ? 'Skip duplicates: ON'
                  : 'Allow duplicates: ON'}
              </span>
            </button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p
                role="status"
                className={`flex items-center gap-1.5 truncate text-sm font-bold ${
                  lastMessageType === 'success'
                    ? 'text-[#6ee7b7]'
                    : lastMessageType === 'error'
                      ? 'text-[#fca5a5]'
                      : 'text-[#d9bbaa]'
                }`}
              >
                {lastMessageType === 'success' && (
                  <Check size={15} className="shrink-0" />
                )}
                <span className="truncate">{lastMessage}</span>
              </p>
              <p className="mt-0.5 text-xs font-semibold text-[#b99b8d]">
                {scanCount} {scanCount === 1 ? 'barcode' : 'barcodes'} ·{' '}
                {totalWeight.toFixed(3)} kg total
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={scanCount === 0}
                onClick={handleUndo}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-white/20 disabled:opacity-35"
                title="Undo last scanned barcode"
              >
                <Undo2 size={15} />
                <span>Undo</span>
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl bg-white px-4 py-2.5 text-sm font-black text-[#29150f] transition hover:bg-[#f5ede6] active:scale-95"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
