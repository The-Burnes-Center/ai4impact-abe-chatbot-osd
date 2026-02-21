import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import IconButton from "@mui/material/IconButton";
import CloseIcon from "@mui/icons-material/Close";
import { useNotifications } from "./notif-manager";

export default function NotificationBar() {
  const { notifications } = useNotifications();

  if (notifications.length === 0) return null;

  return (
    <Stack
      spacing={1}
      sx={{ mb: 2 }}
      role="status"
      aria-live="polite"
      aria-label="Notifications"
    >
      {notifications.map((notif: any) => (
        <Alert
          key={notif.id}
          severity={notif.type === "error" ? "error" : notif.type === "success" ? "success" : "info"}
          action={
            notif.dismissible ? (
              <IconButton
                size="small"
                color="inherit"
                onClick={notif.onDismiss}
                aria-label="Dismiss notification"
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            ) : undefined
          }
        >
          {notif.content}
        </Alert>
      ))}
    </Stack>
  );
}
