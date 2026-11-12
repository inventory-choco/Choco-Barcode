'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Barcode,
  Camera,
  Check,
  Clipboard,
  Download,
  PackageOpen,
  Scale,
  Trash2,
  Undo2,
} from 'lucide-react';
import { CameraScannerModal, unlockScanAudio } from '../src/camera-scanner';

type Scan = { barcode: string; weight: number; itemCode: string };
type Mode = 'home' | '2' | '3' | '4';

function parseBarcode(value: string): Scan | null {
  const barcode = value.trim();
  if (!/^2\d{12}$/.test(barcode)) return null;
  return {
    barcode,
    itemCode: barcode.slice(1, 7),
    weight: Number(barcode.slice(7, 12)) / 1000,
  };
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('home');
  const [scans, setScans] = useState<Scan[]>([]);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('Ready to scan');
  const [messageType, setMessageType] = useState<'ready' | 'success' | 'error'>(
    'ready',
  );
  const [autoEnter, setAutoEnter] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('choco_auto_enter');
      if (saved !== null) return saved === 'true';
    }
    return true;
  });
  const [copiedTotal, setCopiedTotal] = useState(false);
  const [copiedAverage, setCopiedAverage] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  const scannerBuffer = useRef('');
  const scannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKeyTimeRef = useRef<number>(0);
  const isRapidScanRef = useRef<boolean>(false);
  const autoEnterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem('choco_auto_enter', String(autoEnter));
    } catch {
      // Ignore localStorage errors in private windows
    }
  }, [autoEnter]);

  useEffect(() => {
    return () => {
      if (autoEnterTimerRef.current) clearTimeout(autoEnterTimerRef.current);
      if (scannerTimer.current) clearTimeout(scannerTimer.current);
    };
  }, []);

  const addBarcode = useCallback((raw: string) => {
    const parsed = parseBarcode(raw);
    if (!parsed) {
      setMessage('Invalid barcode — use exactly 13 digits starting with 2');
      setMessageType('error');
      return false;
    }
    setScans((current) => [...current, parsed]);
    setMessage(`Added ${parsed.barcode} · ${parsed.weight.toFixed(3)} kg`);
    setMessageType('success');
    return true;
  }, []);

  const isValidBarcode = useCallback(
    (value: string) => parseBarcode(value) !== null,
    [],
  );

  const undoLast = useCallback(() => {
    if (!scans.length) return;
    const removed = scans[scans.length - 1];
    setScans((items) => items.slice(0, -1));
    setMessage(`Removed barcode ${removed.barcode}`);
    setMessageType('ready');
  }, [scans]);

  useEffect(() => {
    if (mode !== '2' || cameraOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (event.key === 'Enter') {
        if (scannerBuffer.current) {
          event.preventDefault();
          addBarcode(scannerBuffer.current);
          scannerBuffer.current = '';
        }
      } else if (/^\d$/.test(event.key)) {
        scannerBuffer.current += event.key;
        if (scannerTimer.current) clearTimeout(scannerTimer.current);

        // If autoEnter is enabled and buffer reaches 13 digits, auto enter immediately
        if (autoEnter && scannerBuffer.current.length === 13) {
          const parsed = parseBarcode(scannerBuffer.current);
          if (parsed) {
            addBarcode(scannerBuffer.current);
            scannerBuffer.current = '';
            return;
          }
        }

        // Debounce timer for scanners without an Enter key
        scannerTimer.current = setTimeout(() => {
          if (autoEnter && scannerBuffer.current) {
            addBarcode(scannerBuffer.current);
          }
          scannerBuffer.current = '';
        }, 220);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (scannerTimer.current) clearTimeout(scannerTimer.current);
    };
  }, [mode, cameraOpen, addBarcode, autoEnter]);

  const total = useMemo(
    () => scans.reduce((sum, scan) => sum + scan.weight, 0),
    [scans],
  );
  const average = scans.length ? total / scans.length : 0;

  const submitInput = (valueToSubmit?: string) => {
    const text = valueToSubmit !== undefined ? valueToSubmit : input;
    const values = text.split(/\s+/).filter(Boolean);
    let added = 0;
    values.forEach((value) => {
      if (addBarcode(value)) added += 1;
    });
    if (added > 0) {
      setInput('');
    } else if (values.length > 0) {
      inputRef.current?.select();
    }
    inputRef.current?.focus();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const now = Date.now();
    const diff = now - lastKeyTimeRef.current;
    lastKeyTimeRef.current = now;

    // Fast keystroke sequence (< 80ms) indicates a hardware barcode scanner
    if (diff < 80) {
      isRapidScanRef.current = true;
    } else if (diff > 250) {
      isRapidScanRef.current = false;
    }
  };

  const handleInputChange = (val: string) => {
    setInput(val);

    if (autoEnterTimerRef.current) {
      clearTimeout(autoEnterTimerRef.current);
      autoEnterTimerRef.current = null;
    }

    if (!autoEnter) return;

    const trimmed = val.trim();

    // 1. If input forms a complete valid 13-digit barcode, auto enter immediately
    if (parseBarcode(trimmed)) {
      addBarcode(trimmed);
      setInput('');
      isRapidScanRef.current = false;
      return;
    }

    // 2. If entered rapidly by a scanner without Enter key, auto-submit on scan end
    if (isRapidScanRef.current && trimmed.length > 0) {
      autoEnterTimerRef.current = setTimeout(() => {
        if (inputRef.current) {
          const currentVal = inputRef.current.value.trim();
          if (currentVal) {
            submitInput(currentVal);
          }
        }
        isRapidScanRef.current = false;
      }, 200);
    }
  };

  const clearAll = () => {
    setScans([]);
    setInput('');
    if (autoEnterTimerRef.current) {
      clearTimeout(autoEnterTimerRef.current);
      autoEnterTimerRef.current = null;
    }
    isRapidScanRef.current = false;
    setMessage('Cleared — ready for a new batch');
    setMessageType('ready');
    inputRef.current?.focus();
  };

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback below
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      return success;
    } catch {
      return false;
    }
  };

  const copyTotal = async () => {
    const ok = await copyToClipboard(total.toFixed(3));
    if (ok !== false) {
      setCopiedTotal(true);
      setTimeout(() => setCopiedTotal(false), 1500);
    }
  };

  const copyAverage = async () => {
    const ok = await copyToClipboard(average.toFixed(3));
    if (ok !== false) {
      setCopiedAverage(true);
      setTimeout(() => setCopiedAverage(false), 1500);
    }
  };

  const exportCsv = () => {
    const rows = [
      'SR,BARCODE,ITEM CODE,WEIGHT KG',
      ...scans.map(
        (s, i) => `${i + 1},${s.barcode},${s.itemCode},${s.weight.toFixed(3)}`,
      ),
    ];
    const url = URL.createObjectURL(
      new Blob([rows.join('\n')], { type: 'text/csv' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `chocolala-barcodes-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (mode === 'home')
    return (
      <main className="min-h-screen bg-[#f7f3ee] text-[#29150f]">
        <header className="border-b border-[#e7d9cc] bg-[#fffdf9] px-6 py-5 sm:px-10">
          <div className="mx-auto flex max-w-6xl items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#5a2417] text-[#fff8ee]">
              <Barcode size={23} />
            </span>
            <div>
              <p className="text-lg font-extrabold tracking-tight">Chocolala</p>
              <p className="text-xs font-semibold uppercase tracking-[.18em] text-[#986b5a]">
                Barcode tools
              </p>
            </div>
          </div>
        </header>
        <section className="mx-auto max-w-6xl px-6 py-14 sm:px-10 sm:py-20">
          <p className="mb-3 text-sm font-bold uppercase tracking-[.16em] text-[#a4482f]">
            Production utility
          </p>
          <h1 className="max-w-2xl text-4xl font-black tracking-[-.04em] sm:text-6xl">
            Choose your barcode type
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-[#765a50]">
            Fast, private calculations for weighing-machine barcodes. Your
            scanned data stays in this browser.
          </p>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            <button
              onClick={() => setMode('2')}
              className="group min-h-56 rounded-[28px] bg-[#5a2417] p-7 text-left text-white shadow-[0_18px_50px_rgba(71,26,15,.2)] transition hover:-translate-y-1 hover:bg-[#6c2a1b] focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-[#d98d64]"
            >
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/12">
                <Scale />
              </span>
              <span className="mt-9 block text-3xl font-black">2-Barcode</span>
              <span className="mt-2 block text-sm text-[#f0cbbc]">
                Weight barcode calculator
              </span>
              <span className="mt-5 inline-flex items-center gap-2 text-sm font-bold">
                Open scanner →
              </span>
            </button>
            {(['3', '4'] as const).map((number) => (
              <button
                key={number}
                onClick={() => setMode(number)}
                className="min-h-56 rounded-[28px] border border-[#dfd1c5] bg-[#fffdf9] p-7 text-left transition hover:border-[#bd9987] hover:shadow-lg"
              >
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#f1e7df] text-[#88685b]">
                  <PackageOpen />
                </span>
                <span className="mt-9 block text-3xl font-black">
                  {number}-Barcode
                </span>
                <span className="mt-2 block text-sm text-[#8a7065]">
                  Coming soon
                </span>
              </button>
            ))}
          </div>
        </section>
      </main>
    );

  if (mode !== '2')
    return (
      <main className="grid min-h-screen place-items-center bg-[#f7f3ee] p-6 text-[#29150f]">
        <div className="text-center">
          <PackageOpen className="mx-auto mb-5 text-[#a4482f]" size={44} />
          <h1 className="text-3xl font-black">{mode}-Barcode</h1>
          <p className="mt-2 text-[#765a50]">
            This tool is ready for future configuration.
          </p>
          <button
            onClick={() => setMode('home')}
            className="mt-8 rounded-xl bg-[#5a2417] px-5 py-3 font-bold text-white"
          >
            Back to barcode types
          </button>
        </div>
      </main>
    );

  return (
    <main className="min-h-screen bg-[#f7f3ee] text-[#29150f]">
      <header className="sticky top-0 z-20 border-b border-[#e7d9cc] bg-[#fffdf9]/95 px-4 py-3 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4">
          <button
            onClick={() => {
              setCameraOpen(false);
              setMode('home');
            }}
            className="inline-flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-bold hover:bg-[#f1e7df]"
          >
            <ArrowLeft size={18} /> Barcode types
          </button>
          <div className="flex items-center gap-2 text-sm font-black">
            <Barcode className="text-[#a4482f]" /> 2-Barcode
          </div>
          <span className="hidden rounded-full bg-[#e7f4e7] px-3 py-1.5 text-xs font-bold text-[#357044] sm:inline">
            ● Scanner active {autoEnter ? '· Auto-enter on' : ''}
          </span>
        </div>
      </header>
      <div className="mx-auto grid max-w-[1500px] gap-6 px-4 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="overflow-hidden rounded-[24px] border border-[#e4d5c9] bg-[#fffdf9] shadow-[0_8px_30px_rgba(61,30,19,.06)]">
          <div className="border-b border-[#eaded4] p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-black tracking-tight">
                  Scan barcodes
                </h1>
                <p className="mt-1 text-sm text-[#80675d]">
                  Scan with a scanner or phone camera, or enter / paste barcodes
                  below.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <label
                  className="inline-flex cursor-pointer select-none items-center gap-2 rounded-xl border border-[#dfd1c5] bg-[#fffdf9] px-3.5 py-2 text-xs font-bold text-[#5a2417] shadow-sm transition hover:bg-[#f5ede6]"
                  title="Automatically add barcodes after scanning without pressing Enter"
                >
                  <input
                    type="checkbox"
                    checked={autoEnter}
                    onChange={(e) => setAutoEnter(e.target.checked)}
                    className="h-4 w-4 rounded border-[#cfb9a9] accent-[#5a2417]"
                  />
                  <span>Auto-enter</span>
                </label>
                <button
                  disabled={!scans.length}
                  onClick={undoLast}
                  className="inline-flex items-center gap-2 rounded-xl border border-[#dfd1c5] px-4 py-2 text-sm font-bold disabled:opacity-35"
                >
                  <Undo2 size={16} /> Undo last
                </button>
              </div>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitInput();
              }}
              className="mt-5 flex gap-2"
            >
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Scan or enter barcode(s)…"
                inputMode="numeric"
                autoFocus
                className="min-w-0 flex-1 rounded-xl border border-[#cfb9a9] bg-white px-4 py-3 font-mono text-base outline-none ring-[#d98d64] focus:ring-3"
                aria-label="Barcode input"
              />
              <button
                type="button"
                onClick={() => {
                  unlockScanAudio();
                  setCameraOpen(true);
                }}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[#cfb9a9] bg-[#faf5f0] px-3.5 font-bold text-[#5a2417] transition hover:bg-[#f1e7df] active:scale-95"
                aria-label="Scan barcode with camera"
                title="Scan barcode with camera"
              >
                <Camera size={20} />
                <span className="hidden sm:inline">Camera</span>
              </button>
              <button
                type="submit"
                className="shrink-0 rounded-xl bg-[#5a2417] px-4 font-bold text-white transition hover:bg-[#6c2a1b] active:scale-95 sm:px-5"
              >
                Add
              </button>
            </form>
            <p
              role="status"
              className={`mt-3 flex items-center gap-2 text-sm font-semibold ${messageType === 'error' ? 'text-[#b43828]' : messageType === 'success' ? 'text-[#357044]' : 'text-[#80675d]'}`}
            >
              {messageType === 'success' && <Check size={16} />} {message}
            </p>
          </div>
          <div className="max-h-[calc(100vh-330px)] min-h-[360px] overflow-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-[#f5ede6] text-xs uppercase tracking-[.1em] text-[#80675d]">
                <tr>
                  <th className="w-20 px-5 py-3">SR</th>
                  <th className="px-5 py-3">Barcode</th>
                  <th className="hidden px-5 py-3 sm:table-cell">Item code</th>
                  <th className="px-5 py-3 text-right">Weight kg</th>
                  <th className="w-16 px-3 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#eee3da]">
                {scans.map((scan, index) => (
                  <tr
                    key={`${scan.barcode}-${index}`}
                    className="hover:bg-[#fbf6f1]"
                  >
                    <td className="px-5 py-3 text-sm font-bold text-[#a0867a]">
                      {index + 1}
                    </td>
                    <td className="px-5 py-3 font-mono font-bold">
                      {scan.barcode}
                    </td>
                    <td className="hidden px-5 py-3 font-mono text-sm text-[#80675d] sm:table-cell">
                      {scan.itemCode}
                    </td>
                    <td className="px-5 py-3 text-right font-mono font-black">
                      {scan.weight.toFixed(3)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setScans((items) =>
                            items.filter((_, itemIndex) => itemIndex !== index),
                          );
                          setMessage(`Deleted barcode ${scan.barcode}`);
                          setMessageType('ready');
                        }}
                        className="inline-grid h-8 w-8 place-items-center rounded-lg text-[#a4482f] transition hover:bg-[#f7ddd4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a4482f]"
                        aria-label={`Delete barcode ${scan.barcode}`}
                        title="Delete this barcode"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
                {!scans.length && (
                  <tr>
                    <td colSpan={5} className="px-5 py-24 text-center">
                      <Barcode
                        className="mx-auto mb-4 text-[#ceb8aa]"
                        size={42}
                      />
                      <p className="font-bold text-[#765a50]">
                        Waiting for your first scan
                      </p>
                      <p className="mt-1 text-sm text-[#a0867a]">
                        13 digits, starting with 2
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
        <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
          <section className="rounded-[24px] bg-[#34170f] p-6 text-white shadow-[0_18px_45px_rgba(52,23,15,.18)]">
            <p className="text-xs font-bold uppercase tracking-[.16em] text-[#dcae99]">
              Batch summary
            </p>
            <div className="mt-5">
              <p className="text-xs text-[#d9bbaa]">Barcodes</p>
              <p className="mt-1 text-3xl font-black">{scans.length}</p>
            </div>
            <div className="mt-5 border-t border-white/15 pt-5">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs text-[#d9bbaa]">Total weight</p>
                  <p className="mt-1 text-3xl font-black">
                    {total.toFixed(3)}
                    <span className="ml-1 text-sm font-semibold text-[#d9bbaa]">
                      kg
                    </span>
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!scans.length}
                  onClick={copyTotal}
                  className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-black text-[#34170f] transition hover:bg-[#f5ede6] active:scale-95 disabled:opacity-40"
                  aria-label="Copy total weight"
                  title="Copy total weight in kg"
                >
                  {copiedTotal ? <Check size={16} /> : <Clipboard size={16} />}{' '}
                  {copiedTotal ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="mt-5 border-t border-white/15 pt-5">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs text-[#d9bbaa]">Average weight</p>
                  <p className="mt-1 text-4xl font-black">
                    {average.toFixed(3)}
                    <span className="ml-1 text-sm font-semibold text-[#d9bbaa]">
                      kg
                    </span>
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!scans.length}
                  onClick={copyAverage}
                  className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-black text-[#34170f] transition hover:bg-[#f5ede6] active:scale-95 disabled:opacity-40"
                  aria-label="Copy average weight"
                  title="Copy average weight in kg"
                >
                  {copiedAverage ? (
                    <Check size={16} />
                  ) : (
                    <Clipboard size={16} />
                  )}{' '}
                  {copiedAverage ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </section>
          <button
            onClick={clearAll}
            disabled={!scans.length}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#c8442d] px-5 py-4 text-base font-black text-white shadow-lg transition hover:bg-[#ae3825] disabled:opacity-40"
          >
            <Trash2 size={19} /> Clear all barcodes
          </button>
          <button
            onClick={exportCsv}
            disabled={!scans.length}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-[#d7c4b6] bg-[#fffdf9] px-5 py-3.5 text-sm font-black disabled:opacity-40"
          >
            <Download size={18} /> Download CSV
          </button>
          <section className="rounded-2xl border border-[#e4d5c9] bg-[#fffdf9] p-5 text-sm text-[#765a50]">
            <p className="font-black text-[#3b2017]">Barcode format</p>
            <p className="mt-2 leading-6">
              <span className="font-mono font-bold text-[#a4482f]">2</span>{' '}
              identifier · <span className="font-mono font-bold">100303</span>{' '}
              item · <span className="font-mono font-bold">00625</span> weight ·
              final check digit
            </p>
          </section>
        </aside>
      </div>
      <CameraScannerModal
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onScan={addBarcode}
        onUndo={undoLast}
        isValidBarcode={isValidBarcode}
        scanCount={scans.length}
        totalWeight={total}
        lastMessage={message}
        lastMessageType={messageType}
      />
    </main>
  );
}
