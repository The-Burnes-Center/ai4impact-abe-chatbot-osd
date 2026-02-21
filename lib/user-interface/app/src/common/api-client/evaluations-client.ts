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
          credentials: "same-origin"
        });
        
        if (response.status === 404) {
          // Return an empty result structure instead of throwing an error
          return { Items: [], NextPageToken: null };
        }
        
        if (!response.ok) {
          const errorText = await response.text();
          // Check for specific DynamoDB errors
          if (errorText.includes("ResourceNotFoundException") || errorText.includes("ValidationException")) {
            return { 
              Items: [], 
              NextPageToken: null,
              error: "Database error: The evaluation summaries could not be retrieved. This may be due to missing tables or incorrect configuration."
            };
          }
          throw new Error(`Failed to get evaluation summaries: ${response.status} ${response.statusText} - ${errorText}`);
        }

        // Get the response text first to log it in case of parsing errors
        const responseText = await response.text();
        
        try {
          // Then parse it as JSON
          const result = JSON.parse(responseText);
          
          // Check if result has Items property, if not create an empty structure
          if (!result.Items) {
            return { Items: [], NextPageToken: null };
          }
          
          return result;
        } catch (parseError) {
          throw new Error(`Invalid JSON response from server: ${parseError.message}`);
        }
      } catch (fetchError) {
        // Handle CORS errors specifically
        if (fetchError.message.includes("CORS") || 
            fetchError.message.includes("cross-origin") || 
            fetchError.message.includes("Cross-Origin")) {
          throw new Error("Cross-Origin Request Blocked: The API doesn't allow requests from this origin. Please check CORS configuration on the API Gateway.");
        }
        throw fetchError;
      }
    } catch (error) {
      // Rethrow the error for the component to handle
      throw error;
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
          credentials: "same-origin"
        });
        
        if (response.status === 404) {
          // Return an empty result structure instead of throwing an error
          return { 
            Items: [], 
            NextPageToken: null,
            error: "API endpoint not found: The results handler API is not available or improperly configured."
          };
        }
        
        if (!response.ok) {
          const errorText = await response.text();
          
          // Check for specific DynamoDB errors
          if (errorText.includes("ResourceNotFoundException") || errorText.includes("ValidationException")) {
            return { 
              Items: [], 
              NextPageToken: null,
              error: "Database error: The evaluation data could not be retrieved. This may be due to missing tables or incorrect configuration."
            };
          }
          
          // Check for other common errors
          if (errorText.includes("AccessDeniedException")) {
            return {
              Items: [],
              NextPageToken: null,
              error: "Access denied: The Lambda function doesn't have permission to access the DynamoDB table."
            };
          }
          
          return {
            Items: [],
            NextPageToken: null,
            error: `Failed to get evaluation results: ${response.status} ${response.statusText} - ${errorText}`
          };
        }

        // Get the response text first to log it in case of parsing errors
        const responseText = await response.text();
        
        try {
          // Then parse it as JSON
          const result = JSON.parse(responseText);
          
          // Check if result has Items property, if not create an empty structure
          if (!result.Items) {
            return { Items: [], NextPageToken: null };
          }
          
          return result;
        } catch (parseError) {
          return {
            Items: [],
            NextPageToken: null,
            error: `Invalid JSON response from server: ${parseError.message}`
          };
        }
      } catch (fetchError) {
        // Handle CORS errors specifically
        if (fetchError.message.includes("CORS") || 
            fetchError.message.includes("cross-origin") || 
            fetchError.message.includes("Cross-Origin")) {
          return {
            Items: [],
            NextPageToken: null,
            error: "Cross-Origin Request Blocked: The API doesn't allow requests from this origin. Please check CORS configuration on the API Gateway."
          };
        }
        
        return {
          Items: [],
          NextPageToken: null,
          error: `Network error: ${fetchError.message}`
        };
      }
    } catch (error) {
      return {
        Items: [],
        NextPageToken: null,
        error: `Client error: ${error.message}`
      };
    }
  }
  async startNewEvaluation(evaluationName: string, testCaseFile: string) {
    try {
      const auth = await Utils.authenticate();
      const body: any = {
        evaluation_name: evaluationName,
        testCasesKey: testCaseFile,
      };
      
      try {
        const response = await fetch(`${this.API}/eval-run-handler`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": auth,
            "Accept": "application/json"
          },
          body: JSON.stringify(body),
          mode: "cors",
          credentials: "same-origin"
        });
        
        if (response.status === 404) {
          throw new Error("Evaluation service is not available. The API endpoint could not be found. Please ensure the backend is deployed correctly.");
        }
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to start new evaluation: ${response.status} ${response.statusText} - ${errorText}`);
        }

        // Get the response text first to log it in case of parsing errors
        const responseText = await response.text();
        
        try {
          // Then parse it as JSON
          const result = JSON.parse(responseText);
          return result;
        } catch (parseError) {
          throw new Error(`Invalid JSON response from server: ${parseError.message}`);
        }
      } catch (fetchError) {
        // Handle CORS errors specifically
        if (fetchError.message.includes("CORS") || 
            fetchError.message.includes("cross-origin") || 
            fetchError.message.includes("Cross-Origin")) {
          throw new Error("Cross-Origin Request Blocked: The API doesn't allow requests from this origin. Please check CORS configuration on the API Gateway.");
        }
        throw fetchError;
      }
    } catch (error) {
      // Rethrow the error for the component to handle
      throw error;
    }
  }

   // Returns a URL from the this.API that allows one file upload to S3 with that exact filename
   async getUploadURL(fileName: string, fileType : string): Promise<string> {    
    if (!fileType) {
      throw new Error('Must have valid file type!');
    }

    try {
      const auth = await Utils.authenticate();
      const response = await fetch(this.API + '/signed-url-test-cases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization' : auth
        },
        body: JSON.stringify({ fileName, fileType }),
        credentials: "same-origin"
      });

      if (!response.ok) {
        throw new Error('Failed to get upload URL');
      }

      const data = await response.json();
      return data.signedUrl;
    } catch (error) {
      throw error;
    }
  }

  // Returns a list of documents in the S3 bucket
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
      credentials: "same-origin"
    });
    if (!response.ok) {
      throw new Error('Failed to get files');
    }
    
    const result = await response.json();
    return result;
  }
}