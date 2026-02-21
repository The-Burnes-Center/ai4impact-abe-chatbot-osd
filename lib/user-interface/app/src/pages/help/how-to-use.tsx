import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Paper from "@mui/material/Paper";
import Box from "@mui/material/Box";

export default function HowToUse() {
  return (
    <Box role="main">
      <Typography variant="h2" component="h1" gutterBottom>
        How to Use ABE
      </Typography>

      <Stack spacing={3}>
        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" gutterBottom>
            Getting Started
          </Typography>
          <Typography variant="body1" color="text.secondary">
            ABE (Assistive Buyer Engine) is an AI-powered chatbot that helps Massachusetts
            procurement officers with purchasing guidance, statewide contracts, and procurement
            processes.
          </Typography>
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" gutterBottom>
            Tips for Best Results
          </Typography>
          <Stack component="ul" spacing={1} sx={{ pl: 2, m: 0 }}>
            <li>
              <Typography variant="body1">Be specific with your questions for more accurate answers</Typography>
            </li>
            <li>
              <Typography variant="body1">Reference specific contract numbers or commodity codes when possible</Typography>
            </li>
            <li>
              <Typography variant="body1">Use the suggested prompts when starting a new conversation</Typography>
            </li>
            <li>
              <Typography variant="body1">Review source links provided with answers for official documentation</Typography>
            </li>
          </Stack>
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" gutterBottom>
            Important Notes
          </Typography>
          <Typography variant="body1" color="text.secondary">
            ABE provides guidance based on available documentation. Always verify
            critical procurement decisions with official policies and consult with
            your procurement team for complex situations.
          </Typography>
        </Paper>
      </Stack>
    </Box>
  );
}
