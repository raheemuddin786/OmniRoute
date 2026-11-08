import { redirect } from "next/navigation";

export default function ProjectsRedirectPage() {
  redirect("/dashboard/analytics?tab=projects");
}
