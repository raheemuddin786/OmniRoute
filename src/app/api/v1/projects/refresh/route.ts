import { POST_REFRESH } from "../route";

// POST /api/v1/projects/refresh — Dedicated endpoint for the UI refresh button
export async function POST(request: Request) {
  return POST_REFRESH(request);
}
