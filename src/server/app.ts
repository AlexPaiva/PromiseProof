import path from "node:path";

import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from "express";
import { createServer as createViteServer } from "vite";

import { createApiRouter } from "./api.js";
import { PromiseProofStore } from "./store.js";
import { RequestValidationError } from "./validation.js";

export interface ApplicationOptions {
  production?: boolean;
  store?: PromiseProofStore;
}

export interface ApplicationRuntime {
  application: Express;
  dispose: () => Promise<void>;
}

function apiNotFound(request: Request, response: Response): void {
  response.status(404).json({
    error: {
      code: "PP_API_NOT_FOUND",
      message: `No API route matches ${request.method} ${request.originalUrl}.`,
    },
  });
}

export async function createApplication(
  options: ApplicationOptions = {},
): Promise<ApplicationRuntime> {
  const application = express();
  const store = options.store ?? new PromiseProofStore();
  const production = options.production ?? process.env.NODE_ENV === "production";
  let dispose = async (): Promise<void> => undefined;

  application.disable("x-powered-by");
  application.use((_request, response, next) => {
    // Test URLs carry a synthetic user ID; never forward it in a Referer header
    // when the browser calls the logical recommendation-service boundary.
    response.setHeader("referrer-policy", "no-referrer");
    next();
  });
  application.use(express.json({ limit: "32kb", strict: true }));
  application.use("/api", (_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });
  application.use("/api", createApiRouter(store));
  application.use("/api", apiNotFound);

  if (production) {
    const clientDirectory = path.resolve(process.cwd(), "dist/client");
    application.use(express.static(clientDirectory));
    application.use((request, response, next) => {
      if (request.method !== "GET" || !request.accepts("html")) {
        next();
        return;
      }

      response.sendFile(path.join(clientDirectory, "index.html"));
    });
  } else {
    const vite = await createViteServer({
      appType: "spa",
      server: {
        middlewareMode: true,
        hmr: process.env.NODE_ENV === "test" ? false : undefined,
      },
    });
    dispose = async () => vite.close();
    application.use(vite.middlewares);
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof RequestValidationError) {
      response.status(400).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({
        error: {
          code: "PP_INVALID_JSON",
          message: "Request body contains invalid JSON.",
        },
      });
      return;
    }

    console.error(error);
    response.status(500).json({
      error: {
        code: "PP_INTERNAL_ERROR",
        message: "The server could not complete the request.",
      },
    });
  };

  application.use(errorHandler);
  return { application, dispose };
}
