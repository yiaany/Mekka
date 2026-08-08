import { MekkaAuthRegister } from "@/components/interfaces/Auth/MekkaAuthRegister";
import AuthLayout from "@/components/layouts/AuthLayout/AuthLayout";
import { DefaultLayout } from "@/components/layouts/DefaultLayout";
import type { NextPageWithLayout } from "@/types";

const RegisterPage: NextPageWithLayout = () => <MekkaAuthRegister />;

RegisterPage.getLayout = (page) => (
  <DefaultLayout>
    <AuthLayout title="Register / Sign in">{page}</AuthLayout>
  </DefaultLayout>
);

export default RegisterPage;
