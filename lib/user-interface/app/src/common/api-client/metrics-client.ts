import {
  Utils
} from "../utils"
import { AppConfig } from "../types"; 

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
      console.log(err);
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
      console.log(err);
      return "unknown";
    }
  }

  async saveChatInteraction(interactionData) {
    // timestamp generated in lambda function
    //console.log(interactionData["interaction_data"]);//.interaction_data);
    //console.log("hi hi")
    console.log(JSON.stringify({interaction_data: interactionData}));
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
        console.log('Error response:', response.status, errorText);
      } else {
        console.log('CHAT INTERACTION SAVED');
      }
    } catch (e) {
      console.log('Error saving chatbot interaction - ' + e);
    }
  }

  async getChatbotUse(startTime? : string, endTime? : string, nextPageToken? : string) {
    try {
      const auth = await Utils.authenticate();
      //console.log("Parameters: " + {startTime,endTime,nextPageToken});
      const params = new URLSearchParams();
      if (startTime) params.append("startTime", startTime);
      console.log(startTime)
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
      console.log("Error retrieving chatbot use data - " + e);
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
      console.log("Error deleting chatbot use datapoints - " + e);
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
        console.error("Download failed:", error);
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
        console.log('Error response:', response.status, errorText);
      } else {
        //console.log('Incremented the logins on ' + date);
      }
    } catch (e) {
      console.log('Error incrementing daily logins - ' + e);
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
      console.log("Error retrieving daily logins - " + e);
      return [];
    }
  }

  async getDailyUses(startDate?: string, endDate?: string) {
    const uses = await this.getChatbotUse(startDate, endDate);
    const objs = uses.Items;
    let dict: {string: number};
    objs.array.forEach(obj => {
      console.log(obj)
      const date = obj['Timestamp'].split('T')[0];

      if (dict[date]) {
        dict[date] += 1;
      } else {
          dict[date] = 1;
      }
    });
    console.log(dict);
  }

  async getAvgUsesPerUsers(startDate: string, endDate: string) {
    // calculates the average daily usage in the last week

    const logins = await this.getDailyLogins(startDate.split('T')[0], endDate.split('T')[0]);
    const users = logins.length;
    console.log(users, "users over the timeframe");

    const uses = await this.getChatbotUse(startDate, endDate);
    console.log(uses['Items'].length / users);
    return uses['Items'].length / users;
  }

}