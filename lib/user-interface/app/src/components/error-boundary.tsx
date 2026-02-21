import { Component, ErrorInfo, ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            minHeight: 300,
            p: 4,
          }}
        >
          <Paper
            sx={{
              p: 4,
              maxWidth: 480,
              textAlign: "center",
              bgcolor: "var(--abe-surface)",
            }}
          >
            <ErrorOutlineIcon
              sx={{ fontSize: 48, color: "error.main", mb: 2 }}
            />
            <Typography variant="h5" sx={{ mb: 1, fontWeight: 600 }}>
              {this.props.fallbackTitle ?? "Something went wrong"}
            </Typography>
            <Typography
              variant="body2"
              sx={{ color: "text.secondary", mb: 3 }}
            >
              An unexpected error occurred. Please try again or refresh the
              page.
            </Typography>
            <Box sx={{ display: "flex", gap: 1.5, justifyContent: "center" }}>
              <Button variant="outlined" onClick={this.handleReset}>
                Try again
              </Button>
              <Button
                variant="contained"
                onClick={() => window.location.reload()}
              >
                Refresh page
              </Button>
            </Box>
          </Paper>
        </Box>
      );
    }

    return this.props.children;
  }
}
