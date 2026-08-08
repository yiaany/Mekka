import { NextApiRequest, NextApiResponse } from "next";

import { apiWrapper } from "@/lib/api/apiWrapper";
import {
  DEFAULT_PROJECT,
  PROJECT_DB_HOST,
  PROJECT_ENDPOINT,
  PROJECT_ENDPOINT_PROTOCOL,
  PROJECT_REST_URL,
} from "@/lib/constants/api";

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req;

  switch (method) {
    case "GET":
      return handleGetAll(req, res);
    default:
      res.setHeader("Allow", ["GET"]);
      res
        .status(405)
        .json({
          data: null,
          error: { message: `Method ${method} Not Allowed` },
        });
  }
}

const handleGetAll = async (_req: NextApiRequest, res: NextApiResponse) => {
  // Platform specific endpoint
  const response = {
    project: {
      ...DEFAULT_PROJECT,
      api_key_supabase_encrypted: "",
      db_host: PROJECT_DB_HOST,
      db_name: "sqlite",
      db_port: 0,
      db_ssl: false,
      db_user: "local",
      services: [
        {
          id: 1,
          name: "Default API",
          app: { id: 1, name: "Auto API" },
          app_config: {
            db_schema: "main",
            endpoint: PROJECT_ENDPOINT,
            realtime_enabled: true,
          },
          service_api_keys: [],
        },
      ],
    },
    autoApiService: {
      id: 1,
      name: "Default API",
      project: { ref: "default" },
      app: { id: 1, name: "Auto API" },
      app_config: {
        db_schema: "main",
        endpoint: PROJECT_ENDPOINT,
        realtime_enabled: true,
      },
      protocol: PROJECT_ENDPOINT_PROTOCOL,
      endpoint: PROJECT_ENDPOINT,
      restUrl: PROJECT_REST_URL,
      defaultApiKey: undefined,
      serviceApiKey: undefined,
      service_api_keys: [],
    },
  };

  return res.status(200).json(response);
};
