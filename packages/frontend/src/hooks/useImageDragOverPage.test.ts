import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useImageDragOverPage } from "./useImageDragOverPage";

describe("useImageDragOverPage", () => {
  let dragEnterHandler: (e: DragEvent) => void;
  let dragLeaveHandler: (e: DragEvent) => void;
  let dragEndHandler: () => void;
  let dropHandler: () => void;

  let mouseUpHandler: () => void;

  beforeEach(() => {
    vi.spyOn(document, "addEventListener").mockImplementation((event, handler) => {
      if (event === "dragenter") dragEnterHandler = handler as (e: DragEvent) => void;
      if (event === "dragleave") dragLeaveHandler = handler as (e: DragEvent) => void;
      if (event === "dragend") dragEndHandler = handler as () => void;
      if (event === "drop") dropHandler = handler as () => void;
      if (event === "mouseup") mouseUpHandler = handler as () => void;
    });
    vi.spyOn(document, "removeEventListener").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false initially", () => {
    const { result } = renderHook(() => useImageDragOverPage());
    expect(result.current.isDraggingImage).toBe(false);
    expect(typeof result.current.clearDragState).toBe("function");
  });

  it("returns true after dragenter with image files", () => {
    const { result } = renderHook(() => useImageDragOverPage());

    const dataTransfer = {
      types: ["Files"],
      items: [{ kind: "file", type: "image/png" }] as unknown as DataTransferItemList,
    } as DataTransfer;

    const event = new Event("dragenter", { bubbles: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer, writable: false });

    act(() => {
      dragEnterHandler(event);
    });

    expect(result.current.isDraggingImage).toBe(true);
  });

  it("stays false when dragenter has no image files", () => {
    const { result } = renderHook(() => useImageDragOverPage());

    const dataTransfer = {
      types: ["text/plain"],
      items: [],
    } as DataTransfer;

    const event = new Event("dragenter", { bubbles: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer, writable: false });

    act(() => {
      dragEnterHandler(event);
    });

    expect(result.current.isDraggingImage).toBe(false);
  });

  it("returns false after dragleave when pointer leaves drop zone", () => {
    const { result } = renderHook(() => useImageDragOverPage());

    const dataTransfer = {
      types: ["Files"],
      items: [{ kind: "file", type: "image/png" }] as unknown as DataTransferItemList,
    } as DataTransfer;

    const enterEvent = new Event("dragenter", { bubbles: true }) as DragEvent;
    Object.defineProperty(enterEvent, "dataTransfer", { value: dataTransfer, writable: false });

    act(() => {
      dragEnterHandler(enterEvent);
    });
    expect(result.current.isDraggingImage).toBe(true);

    const leaveEvent = new Event("dragleave", { bubbles: true }) as DragEvent;
    act(() => {
      dragLeaveHandler(leaveEvent);
    });
    expect(result.current.isDraggingImage).toBe(false);
  });

  it("returns false after dragend", () => {
    const { result } = renderHook(() => useImageDragOverPage());

    const dataTransfer = {
      types: ["Files"],
      items: [{ kind: "file", type: "image/png" }] as unknown as DataTransferItemList,
    } as DataTransfer;

    const enterEvent = new Event("dragenter", { bubbles: true }) as DragEvent;
    Object.defineProperty(enterEvent, "dataTransfer", { value: dataTransfer, writable: false });

    act(() => {
      dragEnterHandler(enterEvent);
    });
    expect(result.current.isDraggingImage).toBe(true);

    act(() => {
      dragEndHandler();
    });
    expect(result.current.isDraggingImage).toBe(false);
  });

  it("returns false after drop", () => {
    const { result } = renderHook(() => useImageDragOverPage());

    const dataTransfer = {
      types: ["Files"],
      items: [{ kind: "file", type: "image/png" }] as unknown as DataTransferItemList,
    } as DataTransfer;

    const enterEvent = new Event("dragenter", { bubbles: true }) as DragEvent;
    Object.defineProperty(enterEvent, "dataTransfer", { value: dataTransfer, writable: false });

    act(() => {
      dragEnterHandler(enterEvent);
    });
    expect(result.current.isDraggingImage).toBe(true);

    act(() => {
      dropHandler();
    });
    expect(result.current.isDraggingImage).toBe(false);
  });

  it("returns false after clearDragState", () => {
    const { result } = renderHook(() => useImageDragOverPage());

    const dataTransfer = {
      types: ["Files"],
      items: [{ kind: "file", type: "image/png" }] as unknown as DataTransferItemList,
    } as DataTransfer;

    const enterEvent = new Event("dragenter", { bubbles: true }) as DragEvent;
    Object.defineProperty(enterEvent, "dataTransfer", { value: dataTransfer, writable: false });

    act(() => {
      dragEnterHandler(enterEvent);
    });
    expect(result.current.isDraggingImage).toBe(true);

    act(() => {
      result.current.clearDragState();
    });
    expect(result.current.isDraggingImage).toBe(false);
  });

  it("returns false after mouseup (fallback when dragend does not fire, e.g. external drag)", () => {
    const { result } = renderHook(() => useImageDragOverPage());

    const dataTransfer = {
      types: ["Files"],
      items: [{ kind: "file", type: "image/png" }] as unknown as DataTransferItemList,
    } as DataTransfer;

    const enterEvent = new Event("dragenter", { bubbles: true }) as DragEvent;
    Object.defineProperty(enterEvent, "dataTransfer", { value: dataTransfer, writable: false });

    act(() => {
      dragEnterHandler(enterEvent);
    });
    expect(result.current.isDraggingImage).toBe(true);

    act(() => {
      mouseUpHandler();
    });
    expect(result.current.isDraggingImage).toBe(false);
  });
});
