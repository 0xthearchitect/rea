import { lazy, Suspense, useState } from "react";
import type { NativeView as Model, NativeOperation } from "../../types/models";
import { Badge, Button, Loading } from "../../components/ui";
const CodeView = lazy(() => import("../editor/CodeView"));
function value(v: unknown) {
  if (v === null || v === undefined) return "Unknown / unavailable";
  return typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
}
type Navigation = {
  follow: (operation: NativeOperation, address: string) => void;
  disabled: boolean;
};
function Table({
  table,
  follow,
  disabled,
}: { table: NonNullable<Model["tables"]>[number] } & Navigation) {
  const [page, setPage] = useState(0);
  return (
    <section className="native-section">
      <h3>{table.title}</h3>
      <table>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.slice(page * 200, page * 200 + 200).map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j}>
                  {j === 0 && table.links?.[page * 200 + i] ? (
                    <Button
                      disabled={disabled}
                      onClick={() => {
                        const link = table.links![page * 200 + i]!;
                        follow(link.operation, link.query);
                      }}
                    >
                      {value(v)}
                    </Button>
                  ) : (
                    value(v)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!table.rows.length && (
        <p>
          No entries returned. Coverage and limitations remain as reported in
          Evidence.
        </p>
      )}
      {table.rows.length > 200 && (
        <div className="modal-actions">
          <span>
            {page * 200 + 1}–{Math.min(table.rows.length, (page + 1) * 200)} of{" "}
            {table.rows.length}
          </span>
          <Button disabled={!page} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <Button
            disabled={(page + 1) * 200 >= table.rows.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </section>
  );
}
export default function NativeView({
  view,
  follow,
  disabled,
}: { view: Model } & Navigation) {
  return (
    <div className="native-view">
      <h2>{view.title}</h2>
      <div className="native-record">
        {view.procedure && (
          <Button
            disabled={disabled}
            onClick={() => follow("function", view.procedure!)}
          >
            Open function
          </Button>
        )}
        {view.actions?.map((action) => (
          <Button
            key={action.label}
            disabled={disabled}
            onClick={() => follow(action.operation, action.query)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {view.record && (
        <div className="native-record">
          <Badge>{view.record.provider ?? "Provider unknown"}</Badge>
          <Badge>
            Record confidence: {view.record.confidence ?? "Unknown"}
          </Badge>
          <Badge>Record authority: {view.record.authority ?? "Unknown"}</Badge>
        </div>
      )}
      <dl className="native-fields">
        {view.fields.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>{value(f.value)}</dd>
          </div>
        ))}
      </dl>
      {!!view.limitations?.length && (
        <details>
          <summary>REA record limitations ({view.limitations.length})</summary>
          <ul>
            {view.limitations.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </details>
      )}
      {view.code !== undefined && (
        <section className="native-section">
          <h3>
            Pseudocode{" "}
            <Badge tone="amber">
              Decompiler-generated · not original source
            </Badge>
          </h3>
          <div className="native-editor">
            <Suspense fallback={<Loading />}>
              <CodeView value={view.code} language="c" />
            </Suspense>
          </div>
        </section>
      )}
      {view.assembly && (
        <section className="native-section">
          <h3>Provider instruction text</h3>
          <div className="native-editor">
            <Suspense fallback={<Loading />}>
              <CodeView value={view.assembly.join("\n")} language="plaintext" />
            </Suspense>
          </div>
        </section>
      )}
      {view.tables?.map((table) => (
        <Table
          key={table.title}
          table={table}
          follow={follow}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
