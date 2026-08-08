import { NextApiRequest, NextApiResponse } from "next";

import { apiWrapper } from "@/lib/api/apiWrapper";
import { DEFAULT_PROJECT } from "@/lib/constants/api";

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
    id: 1,
    primary_email: "local-admin@example.invalid",
    username: "local-admin",
    first_name: "Local",
    last_name: "Admin",
    organizations: [
      {
        id: 1,
        name: process.env.DEFAULT_ORGANIZATION_NAME || "Local Organization",
        slug: "default-org-slug",
        billing_email: "billing@example.invalid",
        projects: [{ ...DEFAULT_PROJECT, connectionString: "" }],
      },
    ],
  };
  return res.status(200).json(response);
};
