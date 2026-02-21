import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Paper from "@mui/material/Paper";
import Box from "@mui/material/Box";

export default function AboutChatbot() {
  return (
    <Box role="main">
      <Typography variant="h2" component="h1" gutterBottom>
        About ABE
      </Typography>

      <Stack spacing={3}>
        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" gutterBottom>
            Assistive Buyer Engine
          </Typography>
          <Typography variant="body1" color="text.secondary">
            ABE is an AI-powered assistant designed for the Massachusetts Executive Office
            to provide guidance on state procurement processes. It uses advanced language
            models and a curated knowledge base of procurement documentation to help users
            find answers quickly and accurately.
          </Typography>
        </Paper>

        <Paper sx={{ p: 3 }}>
          <Typography variant="h4" component="h2" gutterBottom>
            How It Works
          </Typography>
          <Typography variant="body1" color="text.secondary">
            ABE uses Retrieval-Augmented Generation (RAG) to search through official
            procurement documents and provide contextually relevant answers. Source
            documents are linked with each response so you can verify the information.
          </Typography>
        </Paper>
      </Stack>
    </Box>
  );
}
