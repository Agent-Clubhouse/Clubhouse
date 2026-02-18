import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImageCropDialog } from './ImageCropDialog';

// Minimal 1x1 red PNG as base64 data URL
const RED_PIXEL_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

// Mock HTMLCanvasElement
const mockToDataURL = vi.fn(() => 'data:image/png;base64,cropped');
const mockContext = {
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  fillStyle: '',
  beginPath: vi.fn(),
  rect: vi.fn(),
  arc: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  closePath: vi.fn(),
  fill: vi.fn(),
  strokeStyle: '',
  lineWidth: 0,
  stroke: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  clip: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockContext as any);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(mockToDataURL);
});

// Mock Image loading
class MockImage {
  width = 100;
  height = 100;
  src = '';
  onload: (() => void) | null = null;

  constructor() {
    setTimeout(() => this.onload?.(), 0);
  }
}

beforeAll(() => {
  vi.stubGlobal('Image', MockImage);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('ImageCropDialog', () => {
  it('renders with title and buttons', () => {
    render(
      <ImageCropDialog
        imageDataUrl={RED_PIXEL_DATA_URL}
        maskShape="circle"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Position your image')).toBeInTheDocument();
    expect(screen.getByText('Apply')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('renders a canvas element', () => {
    const { container } = render(
      <ImageCropDialog
        imageDataUrl={RED_PIXEL_DATA_URL}
        maskShape="square"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(
      <ImageCropDialog
        imageDataUrl={RED_PIXEL_DATA_URL}
        maskShape="circle"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn();
    render(
      <ImageCropDialog
        imageDataUrl={RED_PIXEL_DATA_URL}
        maskShape="circle"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when backdrop is clicked', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ImageCropDialog
        imageDataUrl={RED_PIXEL_DATA_URL}
        maskShape="circle"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    // Click the backdrop (outermost fixed div)
    const backdrop = container.querySelector('.fixed.inset-0');
    if (backdrop) fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not call onCancel when dialog content is clicked', () => {
    const onCancel = vi.fn();
    render(
      <ImageCropDialog
        imageDataUrl={RED_PIXEL_DATA_URL}
        maskShape="circle"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    // Click the dialog content area (title text)
    fireEvent.click(screen.getByText('Position your image'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onConfirm with cropped data URL when Apply is clicked', async () => {
    const onConfirm = vi.fn();
    render(
      <ImageCropDialog
        imageDataUrl={RED_PIXEL_DATA_URL}
        maskShape="circle"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    // Wait for image to load
    await waitFor(() => {
      fireEvent.click(screen.getByText('Apply'));
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm).toHaveBeenCalledWith('data:image/png;base64,cropped');
    });
  });

  it('renders a zoom slider', () => {
    const { container } = render(
      <ImageCropDialog
        imageDataUrl={RED_PIXEL_DATA_URL}
        maskShape="circle"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const slider = container.querySelector('input[type="range"]');
    expect(slider).toBeInTheDocument();
  });
});
