import { useRef } from "react";
import { UploadIcon } from "../icons/PrdIcons";

const ACCEPTED_FILE_TYPES = ".md,.docx,.pdf";

export interface PrdUploadButtonProps {
  onUpload: (file: File) => void | Promise<void>;
  disabled?: boolean;
}

export function PrdUploadButton({ onUpload, disabled }: PrdUploadButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await onUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        className="flex items-center gap-2 text-sm text-theme-muted hover:text-brand-600 dark:hover:text-brand-400 transition-colors disabled:opacity-40"
      >
        <UploadIcon className="w-4 h-4" />
        <span>Upload existing PRD</span>
        <span className="text-xs text-theme-muted">(.md, .docx, .pdf)</span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        onChange={handleChange}
        className="hidden"
        data-testid="prd-upload-input"
      />
    </>
  );
}
