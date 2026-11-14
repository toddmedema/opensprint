import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { queryKeys, register, signIn } from "./api";
import { ErrorNote } from "./ui";

export function AuthPanel() {
  const queryClient = useQueryClient();
  const base = useId();
  const [mode, setMode] = useState<"register" | "sign-in">("register");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "register")
        return register({ email: email.trim(), name: name.trim(), password });
      return signIn({ email: email.trim(), password });
    },
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.session, user);
    },
  });

  function switchMode(next: "register" | "sign-in") {
    setMode(next);
    setPassword("");
    mutation.reset();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <section className="card">
      <p className="kicker">Session</p>
      <h2>{mode === "register" ? "Create an account" : "Sign in"}</h2>
      <p>Forge uses a cookie session. The password stays on this form until you submit it.</p>
      <div className="actions" role="group" aria-label="Account action">
        <button
          type="button"
          className="quiet"
          onClick={() => switchMode("register")}
          aria-pressed={mode === "register"}
        >
          Register
        </button>
        <button
          type="button"
          className="quiet"
          onClick={() => switchMode("sign-in")}
          aria-pressed={mode === "sign-in"}
        >
          Sign in
        </button>
      </div>
      <form onSubmit={onSubmit}>
        {mode === "register" ? (
          <div className="field">
            <label htmlFor={`${base}-name`}>Name</label>
            <input
              id={`${base}-name`}
              name="name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        ) : null}
        <div className="field">
          <label htmlFor={`${base}-email`}>Email</label>
          <input
            id={`${base}-email`}
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${base}-password`}>Password</label>
          <input
            id={`${base}-password`}
            name="password"
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <ErrorNote error={mutation.error} />
        <div className="actions">
          <button type="submit" disabled={mutation.isPending}>
            {mutation.isPending
              ? mode === "register"
                ? "Creating account…"
                : "Signing in…"
              : mode === "register"
                ? "Register"
                : "Sign in"}
          </button>
        </div>
      </form>
    </section>
  );
}
