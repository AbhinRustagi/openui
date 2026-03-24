"use client";

import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";
import {
  ScrollableTable as OpenUITable,
  TableBody as OpenUITableBody,
  TableCell as OpenUITableCell,
  TableHead as OpenUITableHead,
  TableHeader as OpenUITableHeader,
  TableRow as OpenUITableRow,
} from "../../components/Table";
import { asArray } from "../helpers";
import { ColSchema } from "./schema";

export { ColSchema } from "./schema";

export const Col = defineComponent({
  name: "Col",
  props: ColSchema,
  description: "Column definition",
  component: () => null,
});

export const Table = defineComponent({
  name: "Table",
  props: z.object({
    columns: z.array(Col.ref),
    rows: z.any(),
  }),
  description: "Data table",
  component: ({ props, renderNode }) => {
    const columns = props.columns ?? [];
    const rawRows = asArray(props.rows) as unknown[];

    if (!columns.length) return null;

    // Detect format: array of objects (from Query) vs 2D array (v1 static)
    const isObjectRows =
      rawRows.length > 0 &&
      typeof rawRows[0] === "object" &&
      rawRows[0] !== null &&
      !Array.isArray(rawRows[0]);

    // Extract column keys from Col definitions
    const colKeys = columns.map((c: any) => c.props?.key ?? c.props?.label ?? "");

    return (
      <OpenUITable>
        <OpenUITableHeader>
          <OpenUITableRow>
            {columns.map((c: any, i: number) => (
              <OpenUITableHead key={i}>{c.props?.label ?? ""}</OpenUITableHead>
            ))}
          </OpenUITableRow>
        </OpenUITableHeader>
        <OpenUITableBody>
          {rawRows.map((row: any, ri: number) => {
            let cells: unknown[];
            if (isObjectRows) {
              // Object row: extract values using column keys
              cells = colKeys.map((key: string) => row?.[key] ?? "");
            } else {
              // 2D array row
              cells = asArray(row);
            }
            return (
              <OpenUITableRow key={ri}>
                {cells.map((cell, ci) => (
                  <OpenUITableCell key={ci}>
                    {typeof cell === "object" && cell !== null
                      ? renderNode(cell)
                      : String(cell ?? "")}
                  </OpenUITableCell>
                ))}
              </OpenUITableRow>
            );
          })}
        </OpenUITableBody>
      </OpenUITable>
    );
  },
});
