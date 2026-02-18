import { useRef, useState, useEffect, useCallback } from 'react';

interface ImageCropDialogProps {
  imageDataUrl: string;
  maskShape: 'circle' | 'square';
  onConfirm: (croppedDataUrl: string) => void;
  onCancel: () => void;
  /** Output size in pixels (default 256) */
  outputSize?: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.01;
const CROP_AREA_SIZE = 220;

export function ImageCropDialog({
  imageDataUrl,
  maskShape,
  onConfirm,
  onCancel,
  outputSize = 256,
}: ImageCropDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  // Load image
  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = imageDataUrl;
  }, [imageDataUrl]);

  // Clamp offset so the image always covers the crop area
  const clampOffset = useCallback(
    (ox: number, oy: number, z: number, img: HTMLImageElement) => {
      // Compute the scale that fills the crop area at zoom=1
      const scale = Math.max(CROP_AREA_SIZE / img.width, CROP_AREA_SIZE / img.height) * z;
      const scaledW = img.width * scale;
      const scaledH = img.height * scale;
      const maxOffsetX = Math.max(0, (scaledW - CROP_AREA_SIZE) / 2);
      const maxOffsetY = Math.max(0, (scaledH - CROP_AREA_SIZE) / 2);
      return {
        x: Math.max(-maxOffsetX, Math.min(maxOffsetX, ox)),
        y: Math.max(-maxOffsetY, Math.min(maxOffsetY, oy)),
      };
    },
    [],
  );

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Compute scale to fill crop area at zoom=1
    const baseScale = Math.max(CROP_AREA_SIZE / image.width, CROP_AREA_SIZE / image.height);
    const scale = baseScale * zoom;
    const scaledW = image.width * scale;
    const scaledH = image.height * scale;

    // Draw the image centered + offset
    const imgX = cx - scaledW / 2 + offset.x;
    const imgY = cy - scaledH / 2 + offset.y;
    ctx.drawImage(image, imgX, imgY, scaledW, scaledH);

    // Draw dark overlay with crop cutout
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';

    // Create path for overlay: full canvas minus crop area
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    if (maskShape === 'circle') {
      ctx.arc(cx, cy, CROP_AREA_SIZE / 2, 0, Math.PI * 2, true);
    } else {
      // Square cutout (counterclockwise for subtraction)
      const half = CROP_AREA_SIZE / 2;
      ctx.moveTo(cx - half, cy - half);
      ctx.lineTo(cx - half, cy + half);
      ctx.lineTo(cx + half, cy + half);
      ctx.lineTo(cx + half, cy - half);
      ctx.closePath();
    }
    ctx.fill('evenodd');

    // Draw crop border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (maskShape === 'circle') {
      ctx.arc(cx, cy, CROP_AREA_SIZE / 2, 0, Math.PI * 2);
    } else {
      const half = CROP_AREA_SIZE / 2;
      ctx.rect(cx - half, cy - half, CROP_AREA_SIZE, CROP_AREA_SIZE);
    }
    ctx.stroke();
    ctx.restore();
  }, [image, zoom, offset, maskShape]);

  // Handle mouse drag
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging || !image) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      const clamped = clampOffset(dragStart.current.ox + dx, dragStart.current.oy + dy, zoom, image);
      setOffset(clamped);
    },
    [dragging, zoom, image, clampOffset],
  );

  const handleMouseUp = useCallback(() => setDragging(false), []);

  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragging, handleMouseMove, handleMouseUp]);

  // Handle scroll wheel zoom
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      if (!image) return;
      const delta = -e.deltaY * 0.002;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + delta));
      setZoom(newZoom);
      setOffset((prev) => clampOffset(prev.x, prev.y, newZoom, image));
    },
    [zoom, image, clampOffset],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Handle zoom slider
  const handleZoomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newZoom = parseFloat(e.target.value);
    setZoom(newZoom);
    if (image) {
      setOffset((prev) => clampOffset(prev.x, prev.y, newZoom, image));
    }
  };

  // Generate cropped output
  const handleConfirm = () => {
    if (!image) return;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outputSize;
    outCanvas.height = outputSize;
    const ctx = outCanvas.getContext('2d');
    if (!ctx) return;

    // Apply clip for circle mask
    if (maskShape === 'circle') {
      ctx.beginPath();
      ctx.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2);
      ctx.clip();
    }

    // Map the visible crop area to the output canvas
    const baseScale = Math.max(CROP_AREA_SIZE / image.width, CROP_AREA_SIZE / image.height);
    const scale = baseScale * zoom;
    const outScale = outputSize / CROP_AREA_SIZE;

    const scaledW = image.width * scale * outScale;
    const scaledH = image.height * scale * outScale;
    const imgX = (outputSize - scaledW) / 2 + offset.x * outScale;
    const imgY = (outputSize - scaledH) / 2 + offset.y * outScale;

    ctx.drawImage(image, imgX, imgY, scaledW, scaledH);

    onConfirm(outCanvas.toDataURL('image/png'));
  };

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const canvasSize = CROP_AREA_SIZE + 80; // Extra padding around crop area

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onCancel}>
      <div
        className="bg-ctp-base rounded-xl border border-surface-2 shadow-2xl p-5 flex flex-col items-center gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-ctp-text">
          Position your image
        </h3>

        {/* Canvas area */}
        <canvas
          ref={canvasRef}
          width={canvasSize}
          height={canvasSize}
          className={`rounded-lg ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          onMouseDown={handleMouseDown}
        />

        {/* Zoom slider */}
        <div className="flex items-center gap-3 w-full px-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ctp-subtext0 flex-shrink-0">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
            <path d="M8 11h6" />
          </svg>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            value={zoom}
            onChange={handleZoomChange}
            className="flex-1 accent-ctp-blue h-1"
          />
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ctp-subtext0 flex-shrink-0">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
            <path d="M8 11h6" />
            <path d="M11 8v6" />
          </svg>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3 w-full">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 text-sm rounded-lg bg-surface-0 border border-surface-2
              text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!image}
            className="flex-1 px-4 py-2 text-sm rounded-lg bg-ctp-blue text-white
              hover:bg-ctp-blue/80 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
