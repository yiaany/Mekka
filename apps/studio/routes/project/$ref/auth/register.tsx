import { createFileRoute } from "@tanstack/react-router";

import RegisterPage from "@/pages/project/[ref]/auth/register";

export const Route = createFileRoute("/project/$ref/auth/register")({
  component: AuthRegisterRoute,
  staticData: { authLayoutTitle: "Register / Sign in" },
});

function AuthRegisterRoute() {
  return <RegisterPage dehydratedState={undefined} />;
}
