/**
 * @deprecated Use evalSlice. Re-exported for backward compatibility.
 */
export {
  type EvalState as VerifyState,
  fetchFeedback,
  submitFeedback,
  recategorizeFeedback,
  resolveFeedback,
  setFeedback,
  setEvalError as setVerifyError,
  resetEval as resetVerify,
} from "./evalSlice";
export { default } from "./evalSlice";
