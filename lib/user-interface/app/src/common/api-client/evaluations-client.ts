import { Utils } from "../utils";
import { AppConfig } from "../types";

export class EvaluationsClient {
  private readonly API;
  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0, -1);
  }

  // Fetch evaluation summaries
  async getEvaluationSummaries(continuationToken?: any, limit: number = 10) {
    try {
      const auth = await Utils.authenticate();
      const body: any = {
        operation: "get_evaluation_summaries",
        limit,
      };
      if (continuationToken) {
        body.continuation_token = continuationToken;
      }

      console.log(`Fetching from ${this.API}/eval-results-handler`);
      try {
        const response = await fetch(`${this.API}/eval-results-handler`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": auth,
            "Accept": "application/json"
          },
          body: JSON.stringify(body),
          mode: "cors", 
          credentials: "include"
        });
        
        if (response.status === 404) {
          console.error("API endpoint not found: /eval-results-handler");
          return { 
            Items: [], 
            NextPageToken: null,
            error: "API endpoint not found. Please check that backend services are deployed correctly."
          };
        }
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error("Error response:", response.status, errorText);
          
          // Check for specific DynamoDB errors
          if (errorText.includes("ResourceNotFoundException") || errorText.includes("ValidationException")) {
            console.error("DynamoDB error:", errorText);
            return { 
              Items: [], 
              NextPageToken: null,
              error: "Database error: The evaluation summaries could not be retrieved. This may be due to missing tables or incorrect configuration."
            };
          }
          
          // Return a structured error object
          return {
            Items: [],
            NextPageToken: null,
            error: `API Error (${response.status}): ${errorText || response.statusText}`
          };
        }

        // Get the response text first to log it in case of parsing errors
        const responseText = await response.text();
        console.log("Raw response:", responseText);
        
        try {
          // Then parse it as JSON
          const result = JSON.parse(responseText);
          
          // Check if the response indicates an error even with status 200
          if (result.errorMessage || result.error) {
            console.error("Error in response body:", result.errorMessage || result.error);
            return {
              Items: [],
              NextPageToken: null,
              error: `Backend error: ${result.errorMessage || result.error}`
            };
          }
          
          // Check if result has Items property, if not create an empty structure
          if (!result.Items) {
            console.warn("Response missing Items property, creating empty structure");
            return { Items: [], NextPageToken: null };
          }
          
          return result;
        } catch (parseError) {
          console.error("Error parsing JSON response:", parseError);
          console.error("Raw response was:", responseText);
          return {
            Items: [],
            NextPageToken: null,
            error: `Invalid response format: ${parseError.message}`
          };
        }
      } catch (fetchError) {
        // Handle CORS errors specifically
        if (fetchError.message.includes("CORS") || 
            fetchError.message.includes("cross-origin") || 
            fetchError.message.includes("Cross-Origin")) {
          console.error("CORS error:", fetchError);
          return {
            Items: [],
            NextPageToken: null,
            error: "Cross-Origin Request Blocked: The API doesn't allow requests from this origin. Please check CORS configuration."
          };
        }
        
        return {
          Items: [],
          NextPageToken: null,
          error: `Network error: ${fetchError.message}`
        };
      }
    } catch (error) {
      console.error("Error in getEvaluationSummaries:", error);
      return {
        Items: [],
        NextPageToken: null,
        error: `Unexpected error: ${error.message || "Unknown error"}`
      };
    }
  }

  // Fetch detailed evaluation results
  async getEvaluationResults(evaluationId: string, continuationToken?: any, limit: number = 10) {
    try {
      const auth = await Utils.authenticate();
      const body: any = {
        operation: "get_evaluation_results",
        evaluation_id: evaluationId,
        limit,
      };
      if (continuationToken) {
        body.continuation_token = continuationToken;
      }

      console.log(`Fetching from ${this.API}/eval-results-handler`);
      try {
        const response = await fetch(`${this.API}/eval-results-handler`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": auth,
            "Accept": "application/json"
          },
          body: JSON.stringify(body),
          mode: "cors", // Explicitly set CORS mode
          credentials: "include" // Include credentials if needed
        });
        
        if (response.status === 404) {
          console.error("API endpoint not found: /eval-results-handler");
          // Return an empty result structure instead of throwing an error
          return { Items: [], NextPageToken: null };
        }
        
        if (!response.ok) {
          const errorText = await response.text();
          // Check for specific DynamoDB errors
          if (errorText.includes("ResourceNotFoundException") || errorText.includes("ValidationException")) {
            console.error("DynamoDB error:", errorText);
            return { 
              Items: [], 
              NextPageToken: null,
              error: "Database error: The evaluation data could not be retrieved. This may be due to missing tables or incorrect configuration."
            };
          }
          throw new Error(`Failed to get evaluation results: ${response.status} ${response.statusText} - ${errorText}`);
        }

        // Get the response text first to log it in case of parsing errors
        const responseText = await response.text();
        console.log("Raw response:", responseText);
        
        try {
          // Then parse it as JSON
          const result = JSON.parse(responseText);
          
          // Check if result has Items property, if not create an empty structure
          if (!result.Items) {
            console.warn("Response missing Items property, creating empty structure");
            return { Items: [], NextPageToken: null };
          }
          
          return result;
        } catch (parseError) {
          console.error("Error parsing JSON response:", parseError);
          console.error("Raw response was:", responseText);
          throw new Error(`Invalid JSON response from server: ${parseError.message}`);
        }
      } catch (fetchError) {
        // Handle CORS errors specifically
        if (fetchError.message.includes("CORS") || 
            fetchError.message.includes("cross-origin") || 
            fetchError.message.includes("Cross-Origin")) {
          console.error("CORS error:", fetchError);
          throw new Error("Cross-Origin Request Blocked: The API doesn't allow requests from this origin. Please check CORS configuration on the API Gateway.");
        }
        throw fetchError;
      }
    } catch (error) {
      console.error("Error in getEvaluationResults:", error);
      // Rethrow the error for the component to handle
      throw error;
    }
  }
  async startNewEvaluation(evaluationName: string, testCaseFile: string) {
    try {
      const auth = await Utils.authenticate();
      const body: any = {
        // operation: "start_new_evaluation",
        evaluation_name: evaluationName,
        testCasesKey: testCaseFile,
      };
      console.log("body in the api", body);
      console.log(`Posting to ${this.API}/eval-run-handler`);

      try {
        const response = await fetch(`${this.API}/eval-run-handler`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": auth,
            "Accept": "application/json"
          },
          body: JSON.stringify(body),
          mode: "cors", // Explicitly set CORS mode
          credentials: "include" // Include credentials if needed
        });
        
        if (response.status === 404) {
          console.error("API endpoint not found: /eval-run-handler");
          throw new Error("Evaluation service is not available. The API endpoint could not be found. Please ensure the backend is deployed correctly.");
        }
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to start new evaluation: ${response.status} ${response.statusText} - ${errorText}`);
        }

        // Get the response text first to log it in case of parsing errors
        const responseText = await response.text();
        console.log("Raw response:", responseText);
        
        try {
          // Then parse it as JSON
          const result = JSON.parse(responseText);
          return result;
        } catch (parseError) {
          console.error("Error parsing JSON response:", parseError);
          console.error("Raw response was:", responseText);
          throw new Error(`Invalid JSON response from server: ${parseError.message}`);
        }
      } catch (fetchError) {
        // Handle CORS errors specifically
        if (fetchError.message.includes("CORS") || 
            fetchError.message.includes("cross-origin") || 
            fetchError.message.includes("Cross-Origin")) {
          console.error("CORS error:", fetchError);
          throw new Error("Cross-Origin Request Blocked: The API doesn't allow requests from this origin. Please check CORS configuration on the API Gateway.");
        }
        throw fetchError;
      }
    } catch (error) {
      console.error("Error in startNewEvaluation:", error);
      // Rethrow the error for the component to handle
      throw error;
    }
  }

   // Returns a URL from the this.API that allows one file upload to S3 with that exact filename
   async getUploadURL(fileName: string, fileType : string): Promise<string> {    
    if (!fileType) {
      alert('Must have valid file type!');
      return;
    }

    try {
      const auth = await Utils.authenticate();
      const response = await fetch(this.API + '/signed-url-test-cases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization' : auth
        },
        body: JSON.stringify({ fileName, fileType })
      });

      if (!response.ok) {
        throw new Error('Failed to get upload URL');
      }

      const data = await response.json();
      return data.signedUrl;
    } catch (error) {
      console.error('Error:', error);
      throw error;
    }
  }

  // Returns a list of documents in the S3 bucket (hard-coded on the backend)
  async getDocuments(continuationToken?: string, pageIndex?: number) {
    const auth = await Utils.authenticate();
    const response = await fetch(this.API + '/s3-test-cases-bucket-data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization' : auth
      },
      body: JSON.stringify({
        continuationToken: continuationToken,
        pageIndex: pageIndex,
      }),
    });
    if (!response.ok) {
      throw new Error('Failed to get files');
    }
    console.log('response in the api', response);
    const result = await response.json();
    return result;
  }
}