import { ReactNode, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Breadcrumbs from "@mui/material/Breadcrumbs";
import Link from "@mui/material/Link";
import Alert from "@mui/material/Alert";
import Skeleton from "@mui/material/Skeleton";
import { Auth } from "aws-amplify";
import { CHATBOT_NAME } from "../common/constants";

interface AdminPageLayoutProps {
  title: string;
  description?: string;
  breadcrumbLabel: string;
  children: ReactNode;
  actions?: ReactNode;
}

export default function AdminPageLayout({
  title,
  description,
  breadcrumbLabel,
  children,
  actions,
}: AdminPageLayoutProps) {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await Auth.currentAuthenticatedUser();
        if (!result || Object.keys(result).length === 0) {
          Auth.signOut();
          return;
        }
        const adminRole =
          result?.signInUserSession?.idToken?.payload["custom:role"];
        if (adminRole) {
          const data = JSON.parse(adminRole);
          if (data.some((role: string) => role.includes("Admin"))) {
            setAdmin(true);
            return;
          }
        }
        setAdmin(false);
      } catch (e) {
        console.error(e);
        setAdmin(false);
      }
    })();
  }, []);

  if (admin === null) {
    return (
      <Stack spacing={3} sx={{ maxWidth: 1200, mx: "auto" }}>
        <Skeleton variant="text" width={200} height={24} />
        <Skeleton variant="text" width={300} height={40} />
        <Skeleton variant="rounded" height={200} />
      </Stack>
    );
  }

  if (!admin) {
    return (
      <Box
        sx={{
          height: "60vh",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Alert severity="error">
          You are not authorized to view this page.
        </Alert>
      </Box>
    );
  }

  return (
    <Stack spacing={3} sx={{ maxWidth: 1200, mx: "auto" }}>
      <Breadcrumbs aria-label="breadcrumb">
        <Link
          component="button"
          underline="hover"
          color="inherit"
          onClick={() => navigate("/")}
          sx={{ fontSize: "0.8125rem" }}
        >
          {CHATBOT_NAME}
        </Link>
        <Typography color="text.primary" sx={{ fontSize: "0.8125rem" }}>
          {breadcrumbLabel}
        </Typography>
      </Breadcrumbs>

      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        spacing={1}
      >
        <Box>
          <Typography variant="h2" component="h1">
            {title}
          </Typography>
          {description && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {description}
            </Typography>
          )}
        </Box>
        {actions && <Box>{actions}</Box>}
      </Stack>

      {children}
    </Stack>
  );
}
