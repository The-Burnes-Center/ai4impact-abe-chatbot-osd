import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";

export default function NotFound() {
  const navigate = useNavigate();

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "50vh",
        textAlign: "center",
        py: 6,
      }}
      role="main"
    >
      <Typography
        variant="h1"
        sx={{ fontSize: { xs: "3rem", sm: "4rem" }, color: "text.secondary", mb: 1 }}
      >
        404
      </Typography>
      <Typography variant="h3" sx={{ mb: 1 }}>
        Page not found
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4, maxWidth: 400 }}>
        The page you are looking for does not exist or may have been moved.
      </Typography>
      <Button
        variant="contained"
        size="large"
        onClick={() => navigate(`/chatbot/playground/${uuidv4()}`)}
      >
        Go to Chat
      </Button>
    </Box>
  );
}
