export const scenarioDefinitions = {
  "scenario-1": { collection: "sources", label: "单表", jobLabel: "单表", overviewPage: "overview", pagePrefix: "" },
  "scenario-2": { collection: "pairs", label: "多表匹配", jobLabel: "多表匹配", overviewPage: "scenario2-overview", pagePrefix: "scenario2" },
  "scenario-3": { collection: "books", label: "架上包", jobLabel: "架上包", overviewPage: "scenario3-overview", pagePrefix: "scenario3" }
};

export function scenarioApi(scenario, path) {
  return `/api/scenarios/${scenario}${path}`;
}

export function scenarioForPage(page) {
  return Object.entries(scenarioDefinitions)
    .find(([, definition]) => definition.pagePrefix && String(page).startsWith(definition.pagePrefix))?.[0] || "scenario-1";
}

export function emptyScenarioData(scenario) {
  const definition = scenarioDefinitions[scenario] || scenarioDefinitions["scenario-1"];
  return { [definition.collection]: [], runs: [] };
}
