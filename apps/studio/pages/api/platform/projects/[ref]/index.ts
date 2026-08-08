import { NextApiRequest, NextApiResponse } from "next";

import { apiWrapper } from "@/lib/api/apiWrapper";
import { DEFAULT_PROJECT, PROJECT_REST_URL } from "@/lib/constants/api";

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req;

  switch (method) {
    case "GET":
      return handleGet(req, res);
    default:
      res.setHeader("Allow", ["GET"]);
      res.status(405).json({
        data: null,
        error: { message: `Method ${method} Not Allowed` },
      });
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  const ref = Array.isArray(req.query.ref) ? req.query.ref[0] : req.query.ref;
  if (ref !== "local") {
    return res.status(404).json({ error: { message: "Project not found" } });
  }
  // Platform specific endpoint
  const response = {
    ...DEFAULT_PROJECT,
    ref,
    connectionString: "",
    restUrl: PROJECT_REST_URL,
  };

  return res.status(200).json(response);
};
