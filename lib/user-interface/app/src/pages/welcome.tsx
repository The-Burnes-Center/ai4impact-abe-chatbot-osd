import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Paper from "@mui/material/Paper";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import Avatar from "@mui/material/Avatar";
import { CHATBOT_NAME } from "../common/constants";

export default function Welcome() {
  const navigate = useNavigate();

  return (
    <Box role="main">
      <Stack spacing={3} sx={{ maxWidth: 800, mx: "auto", py: 4 }}>
        <Box sx={{ textAlign: "center", mb: 2 }}>
          <Avatar
            sx={{
              width: 64,
              height: 64,
              bgcolor: "primary.light",
              color: "primary.main",
              mx: "auto",
              mb: 2,
            }}
          >
            <SmartToyOutlinedIcon sx={{ fontSize: 32 }} />
          </Avatar>
          <Typography variant="h1" component="h1" sx={{ mb: 1 }}>
            {CHATBOT_NAME}
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 500, mx: "auto" }}>
            An AI-powered assistant for Massachusetts state procurement guidance,
            statewide contracts, and purchasing processes.
          </Typography>
        </Box>

        <Box sx={{ textAlign: "center" }}>
          <Button
            variant="contained"
            size="large"
            onClick={() => navigate(`/chatbot/playground/${uuidv4()}`)}
            sx={{ px: 4, py: 1.5 }}
          >
            Start a Conversation
          </Button>
        </Box>

        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" gutterBottom>
            What ABE Can Help With
          </Typography>
          <Stack component="ul" spacing={1} sx={{ pl: 2, m: 0 }}>
            <li><Typography variant="body1">Finding statewide contracts and vendor information</Typography></li>
            <li><Typography variant="body1">Understanding procurement processes and thresholds</Typography></li>
            <li><Typography variant="body1">Navigating bidding requirements and forms</Typography></li>
            <li><Typography variant="body1">Locating training resources and job aids</Typography></li>
          </Stack>
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" gutterBottom>
            Important Notice
          </Typography>
          <Typography variant="body1" color="text.secondary">
            This tool is for Executive Office use only. While ABE can provide
            guidance based on official procurement documentation, always validate
            critical decisions with official policies and confirm permissions before
            procuring goods or services.
          </Typography>
        </Paper>
      </Stack>
    </Box>
  );
}
