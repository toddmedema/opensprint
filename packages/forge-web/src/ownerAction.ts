import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useState } from "react";

type OwnerSubmit = {
  ownerKey: string;
  setOwnerKey: (value: string) => void;
  pending: boolean;
  error: unknown;
  notice: string | null;
  submit: (
    ownerKey: string,
    action: (ownerKey: string) => Promise<unknown>,
    success: string
  ) => Promise<void>;
};

export function useOwnerSubmit(keys: QueryKey[]): OwnerSubmit {
  const queryClient = useQueryClient();
  const [ownerKey, setOwnerKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(
    key: string,
    action: (ownerKey: string) => Promise<unknown>,
    success: string
  ) {
    setError(null);
    setNotice(null);
    if (!key.trim()) {
      setError(new Error("Enter the owner key."));
      return;
    }
    setOwnerKey("");
    setPending(true);
    try {
      await action(key);
      setNotice(success);
      try {
        await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      } catch (refreshError) {
        setError(refreshError);
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  return { ownerKey, setOwnerKey, pending, error, notice, submit };
}
