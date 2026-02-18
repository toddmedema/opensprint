/**
 * Re-export from deliver.ts for backward compatibility.
 * The Deliver phase API routes were renamed from /deploy to /deliver (opensprint.dev-60k.15).
 */
export {
  deliverRouter as deployRouter,
  runDeployAsync,
  type DeliverStatusResponse as DeployStatusResponse,
} from "./deliver.js";
