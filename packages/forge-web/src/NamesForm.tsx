const ROWS = [
  { thing: "Project", meaning: "The repository the team ships" },
  { thing: "Frame", meaning: "The spec: the narrative of what we are building" },
  { thing: "Work item", meaning: "One unit of work in the queue" },
  { thing: "Agent", meaning: "The runtime that reads the repo and does the work" },
  { thing: "Runbook", meaning: "The commands the server will actually run" },
];

export function NamesForm({ showTable = false }: { showTable?: boolean }) {
  return (
    <section className="card stack">
      <div>
        <p className="kicker">Language</p>
        <h2>Five names</h2>
        <p className="lead">
          A new user needs five names: project, frame, work item, agent, and runbook. Gates, run
          control, and Evolve come after those.
        </p>
      </div>
      {showTable ? (
        <div className="table-wrap">
          <table>
            <caption>The five names</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">What it is</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.thing}>
                  <th scope="row">{row.thing}</th>
                  <td>{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
