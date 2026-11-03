import { type SetupServer as SetupServerApi, setupServer } from "msw/node";
import { allHandlers } from "./handlers";

// MSW 3 names the server type `SetupServer`; older releases called it `SetupServerApi`.
export const mockServer: SetupServerApi = setupServer(...allHandlers);
