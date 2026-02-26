import { useState, useCallback } from "react";

export const MAX_IMAGES = 5;
export const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
];

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function isImageFile(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(file.type);
}

export interface UseImageAttachmentReturn {
  images: string[];
  addImagesFromFiles: (files: FileList | File[]) => Promise<void>;
  removeImage: (index: number) => void;
  reset: () => void;
  /** Reset to specific images (e.g. when restoring from localStorage). */
  resetTo: (images: string[]) => void;
  handlePaste: (e: React.ClipboardEvent) => Promise<void>;
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (e: React.DragEvent) => Promise<void>;
  handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function useImageAttachment(initialImages?: string[]): UseImageAttachmentReturn {
  const [images, setImages] = useState<string[]>(() => {
    if (!initialImages || !Array.isArray(initialImages)) return [];
    return initialImages.filter((img) => typeof img === "string" && img.startsWith("data:image/"));
  });

  const addImagesFromFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(isImageFile);
    const toAdd: string[] = [];
    for (const file of fileArray) {
      if (toAdd.length >= MAX_IMAGES) break;
      if (file.size > MAX_IMAGE_SIZE_BYTES) continue;
      try {
        const base64 = await fileToBase64(file);
        toAdd.push(base64);
      } catch {
        // Skip invalid files
      }
    }
    if (toAdd.length > 0) {
      setImages((prev) => [...prev, ...toAdd].slice(0, MAX_IMAGES));
    }
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const reset = useCallback(() => {
    setImages([]);
  }, []);

  const resetTo = useCallback((imgs: string[]) => {
    setImages(
      Array.isArray(imgs) ? imgs.filter((img) => typeof img === "string" && img.startsWith("data:image/")) : []
    );
  }, []);

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        await addImagesFromFiles(files);
      }
    },
    [addImagesFromFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer?.files;
      if (files?.length) await addImagesFromFiles(files);
    },
    [addImagesFromFiles]
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files?.length) addImagesFromFiles(files);
      e.target.value = "";
    },
    [addImagesFromFiles]
  );

  return {
    images,
    addImagesFromFiles,
    removeImage,
    reset,
    resetTo,
    handlePaste,
    handleDragOver,
    handleDrop,
    handleFileInputChange,
  };
}
