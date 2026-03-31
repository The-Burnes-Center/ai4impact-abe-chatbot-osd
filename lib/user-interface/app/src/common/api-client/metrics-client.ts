import {
  Utils
} from "../utils"
import { AppConfig } from "../types";

function devLog(...args: unknown[]) {
  if (import.meta.env.DEV) console.log(...args);
}

// This was made by cohort 1. I'm using it to add KPI data
export class MetricClient {
  private readonly API: string;
  constructor(protected _appConfig: AppConfig) {
    this.API = _appConfig.httpEndpoint.slice(0,-1);}

  async getInvocationCount() {
    try {
      const auth = await Utils.authenticate();      
      const response = await fetch(this.API + '/chat-invocations-count', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization' : auth,
          "Access-Control-Allow-Origin": "*",
        },        
      });
      //console.log(response);
      return await response.json()
    }
    catch (err) {
      devLog(err);
      return "unknown";
    }
  }

  async getResponseTime() {
    try {
      const auth = await Utils.authenticate();      
      const response = await fetch(this.API + '/response-time', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization' : auth
        },        
      });
      //console.log(response);
      return await response.json()
    }
    catch (err) {
      devLog(err);
      return "unknown";
    }
  }

  async saveChatInteraction(interactionData) {
    // timestamp generated in lambda function
    //console.log(interactionData["interaction_data"]);//.interaction_data);
    //console.log("hi hi")
    try {
      const auth = await Utils.authenticate();      
      const response = await fetch(this.API + '/chatbot-use', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization' : auth,
        },
        body: JSON.stringify({interaction_data: interactionData}),
      })
      //console.log(JSON.stringify({interaction_data: interactionData}));
      if (!response.ok) {
        const errorText = await response.text();
        devLog("Error response:", response.status, errorText);
      }
    } catch (e) {
      devLog("Error saving chatbot interaction", e);
    }
  }

  async getChatbotUse(startTime? : string, endTime? : string, nextPageToken? : string) {
    try {
      const auth = await Utils.authenticate();
      //console.log("Parameters: " + {startTime,endTime,nextPageToken});
      const params = new URLSearchParams();
      if (startTime) params.append("startTime", startTime);
      if (endTime) params.append("endTime", endTime);
      if (nextPageToken) params.append("nextPageToken", nextPageToken);

      const url = `${this.API}/chatbot-use?${params.toString()}`;
      //console.log("This is the link we're using to fetch response:", url);
    
      const response = await fetch(this.API + '/chatbot-use?' + params.toString(), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization' : auth,
        },        
      });
      return await response.json()
    } catch (e) {
      devLog("Error retrieving chatbot use data", e);
    }
}

  async deleteChatbotUses(timestamp: string) {
    try {
      const auth = await Utils.authenticate();
      const params = new URLSearchParams({Timestamp: timestamp});
      await fetch(this.API + '/chatbot-use?' + params.toString(), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': auth
        },      
      });
    } catch (e) {
      devLog("Error deleting chatbot use datapoints", e);
    }
    
  }

  async downloadChatbotUses(startTime?: string, endTime?: string) {
    try {
        const auth = await Utils.authenticate();
        const response = await fetch(this.API + '/chatbot-use/download', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': auth
            },
            body: JSON.stringify({ startTime, endTime })
        });

        // Check if the response is OK, else throw an error
        if (!response.ok) {
            throw new Error(`Failed to fetch download URL: ${response.statusText}`);
        }

        const result = await response.json();

        // Fetch the actual file for download
        const fileResponse = await fetch(result.download_url);
        if (!fileResponse.ok) {
            throw new Error("Failed to download the file.");
        }

        const blob = await fileResponse.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        // readable dates yyyy-mm-dd
        if (!startTime) throw new Error("startTime is required for download filename");
        const [startYear, startMonth, startDayTime] = startTime.split('-');
        const startDay = startDayTime.split('T')[0];
        const newStart = `${startYear}-${startMonth}-${startDay}`;
        const [endYear, endtMonth, endDayTime] = startTime.split('-');
        const endDay = endDayTime.split('T')[0];
        const newEnd = `${endYear}-${endtMonth}-${endDay}`;
        a.download = `interaction-data-${newStart}_to_${newEnd}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } catch (error) {
        devLog("Download failed:", error);
        throw error;
    }
  }

  async incrementLogin() {
    //console.log(JSON.stringify({interaction_data: interactionData}));
    try {
      const auth = await Utils.authenticate();      
      const response = await fetch(this.API + '/daily-logins', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization' : auth,
        },
        //body: JSON.stringify({date: date}), // does something need to be here?
      })
      //console.log(JSON.stringify({interaction_data: interactionData}));
      if (!response.ok) {
        const errorText = await response.text();
        devLog("Error response:", response.status, errorText);
      }
    } catch (e) {
      devLog("Error incrementing daily logins", e);
    }
  }

  async getDailyLogins(startDate? : string, endDate? : string) {
    try {
      const auth = await Utils.authenticate();
      const params = new URLSearchParams();
      if (startDate) params.append("startDate", startDate);
      if (endDate) params.append("endDate", endDate);

      const url = `${this.API}/daily-logins?${params.toString()}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization' : auth,
        },        
      });
      const data = await response.json();
      // return the data part of the series BarChart
      const chartData = data['logins'].map((item) => ({x: item['Timestamp'], y: parseInt(item['Count'])}));
    
      return chartData;
    } catch (e) {
      devLog("Error retrieving daily logins", e);
      return [];
    }
  }

  async getDailyUses(startDate?: string, endDate?: string) {
    const uses = await this.getChatbotUse(startDate, endDate);
    const objs = uses.Items;
    let dict: {string: number};
    objs.array.forEach(obj => {
      const date = obj['Timestamp'].split('T')[0];

      if (dict[date]) {
        dict[date] += 1;
      } else {
          dict[date] = 1;
      }
    });
  }

  async getAvgUsesPerUsers(startDate: string, endDate: string) {
    // calculates the average daily usage in the last week

    const logins = await this.getDailyLogins(startDate.split('T')[0], endDate.split('T')[0]);
    const users = logins.length;

    const uses = await this.getChatbotUse(startDate, endDate);
    return uses['Items'].length / users;
  }

  async getMetrics() {
    try {
      const auth = await Utils.authenticate();
      const response = await fetch(this.API + '/metrics', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': auth,
        },
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch metrics: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (err) {
      devLog("Error retrieving metrics:", err);
      throw err;
    }
  }

  async getFAQInsights(days: number = 30) {
    try {
      const auth = await Utils.authenticate();
      const response = await fetch(`${this.API}/metrics?type=faq&days=${days}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': auth,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch FAQ insights: ${response.statusText}`);
      }

      return await response.json();
    } catch (err) {
      devLog("Error retrieving FAQ insights:", err);
      throw err;
    }
  }

  async getAgencyBreakdown(days: number = 30) {
    try {
      const auth = await Utils.authenticate();
      const response = await fetch(`${this.API}/metrics?type=by_agency&days=${days}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': auth,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch agency breakdown: ${response.statusText}`);
      }

      return await response.json();
    } catch (err) {
      devLog("Error retrieving agency breakdown:", err);
      throw err;
    }
  }

  async getUserBreakdown(days: number = 30) {
    try {
      const auth = await Utils.authenticate();
      const response = await fetch(`${this.API}/metrics?type=by_user&days=${days}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': auth,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch user breakdown: ${response.statusText}`);
      }

      return await response.json();
    } catch (err) {
      devLog("Error retrieving user breakdown:", err);
      throw err;
    }
  }

  async getTrafficDetails(days: number = 30) {
    try {
      const auth = await Utils.authenticate();
      const response = await fetch(`${this.API}/metrics?type=traffic&days=${days}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': auth,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch traffic details: ${response.statusText}`);
      }

      return await response.json();
    } catch (err) {
      devLog("Error retrieving traffic details:", err);
      throw err;
    }
  }

}