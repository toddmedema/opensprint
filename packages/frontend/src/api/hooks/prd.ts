import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../client";
import { queryKeys } from "../queryKeys";
import { parsePrdSections } from "../../lib/prdUtils";

const SKETCH_CONTEXT = "sketch";

export function usePrd(projectId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.prd.detail(projectId ?? ""),
    queryFn: async () => {
      const data = await api.prd.get(projectId!);
      return parsePrdSections(data);
    },
    enabled: Boolean(projectId) && options?.enabled !== false,
  });
}

export function usePrdHistory(projectId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.prd.history(projectId ?? ""),
    queryFn: () => api.prd.getHistory(projectId!),
    enabled: Boolean(projectId) && options?.enabled !== false,
  });
}

export function useSketchChat(projectId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.chat.history(projectId ?? "", SKETCH_CONTEXT),
    queryFn: async () => {
      const conv = await api.chat.history(projectId!, SKETCH_CONTEXT);
      return conv?.messages ?? [];
    },
    enabled: Boolean(projectId) && options?.enabled !== false,
  });
}

export function useSavePrdSection(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ section, content }: { section: string; content: string }) =>
      api.prd.updateSection(projectId, section, content),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.prd.detail(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.prd.history(projectId) });
    },
  });
}

export function useSendSketchMessage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      message,
      prdSectionFocus,
      images,
    }: {
      message: string;
      prdSectionFocus?: string;
      images?: string[];
    }) => api.chat.send(projectId, message, SKETCH_CONTEXT, prdSectionFocus, images),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.prd.detail(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.prd.history(projectId) });
      void qc.invalidateQueries({
        queryKey: queryKeys.chat.history(projectId, SKETCH_CONTEXT),
      });
    },
  });
}

/** Read file as text (for uploadPrdFile) */
async function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("Failed to read file"));
    r.readAsText(file);
  });
}

export function useUploadPrdFile(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (ext === "md") {
        const text = await readFileAsText(file);
        const prompt = `Here's my existing product requirements document. Please analyze it and generate a structured PRD from it:\n\n${text}`;
        const response = await api.chat.send(projectId, prompt, SKETCH_CONTEXT);
        return { response, fileName: file.name };
      }
      if (ext === "docx" || ext === "pdf") {
        const result = await api.prd.upload(projectId, file);
        if (result.text) {
          const prompt = `Here's my existing product requirements document. Please analyze it and generate a structured PRD from it:\n\n${result.text}`;
          const response = await api.chat.send(projectId, prompt, SKETCH_CONTEXT);
          return { response, fileName: file.name };
        }
        return { response: null, fileName: file.name };
      }
      throw new Error("Unsupported file type. Please use .md, .docx, or .pdf");
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.prd.detail(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.prd.history(projectId) });
      void qc.invalidateQueries({
        queryKey: queryKeys.chat.history(projectId, SKETCH_CONTEXT),
      });
    },
  });
}
