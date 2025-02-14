import {
  Completion,
  CompletionContext,
  CompletionResult,
  snippetCompletion,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { SyntaxNode } from "@lezer/common";
import { JSONSchema7, JSONSchema7Definition } from "json-schema";
import { debug } from "./utils/debug";
import {
  findNodeIndexInArrayNode,
  getChildValueNode,
  getWord,
  isPropertyNameNode,
  isPrimitiveValueNode,
  stripSurroundingQuotes,
  getNodeAtPosition,
} from "./utils/node";
import { Draft07, JsonError } from "json-schema-library";
import { jsonPointerForPosition } from "./utils/jsonPointers";
import { TOKENS } from "./constants";
import getSchema from "./utils/schema-lib/getSchema";

function json5PropertyInsertSnippet(rawWord: string, value: string) {
  if (rawWord.startsWith('"')) {
    return `"${value}"`;
  }
  if (rawWord.startsWith("'")) {
    return `'${value}'`;
  }
  return value;
}

class CompletionCollector {
  completions = new Map<string, Completion>();
  reservedKeys = new Set<string>();

  reserve(key: string) {
    this.reservedKeys.add(key);
  }

  add(completion: Completion) {
    if (this.reservedKeys.has(completion.label)) {
      return;
    }
    this.completions.set(completion.label, completion);
  }
}

type JSONCompletionOptions = {
  mode?: "json" | "json5";
};

export class JSONCompletion {
  public constructor(
    private schema: JSONSchema7,
    private opts: JSONCompletionOptions
  ) {}

  public doComplete(ctx: CompletionContext) {
    const result: CompletionResult = {
      from: ctx.pos,
      to: ctx.pos,
      options: [],
      filter: false, // will be handled manually
    };

    const text = ctx.state.doc.sliceString(0);
    let node: SyntaxNode | null = getNodeAtPosition(ctx.state, ctx.pos);

    // position node word prefix (without quotes) for matching
    const prefix = ctx.state.sliceDoc(node.from, ctx.pos).replace(/^("|')/, "");

    debug.log("xxx", "node", node, "prefix", prefix, "ctx", ctx);

    // Only show completions if we are filling out a word or right after the starting quote, or if explicitly requested
    if (
      !(isPrimitiveValueNode(node) || isPropertyNameNode(node)) &&
      !ctx.explicit
    ) {
      return result;
    }

    const currentWord = getWord(ctx.state.doc, node);
    const rawWord = getWord(ctx.state.doc, node, false);
    // Calculate overwrite range
    if (node && (isPrimitiveValueNode(node) || isPropertyNameNode(node))) {
      result.from = node.from;
      result.to = node.to;
    } else {
      const word = ctx.matchBefore(/[A-Za-z0-9._]*/);
      const overwriteStart = ctx.pos - currentWord.length;
      debug.log(
        "xxx",
        "overwriteStart after",
        overwriteStart,
        "ctx.pos",
        ctx.pos,
        "word",
        word,
        "currentWord",
        currentWord,
        "=>",
        text[overwriteStart - 1],
        "..",
        text[overwriteStart],
        "..",
        text
      );
      result.from =
        node.name === TOKENS.INVALID ? word?.from ?? ctx.pos : overwriteStart;
      result.to = ctx.pos;
    }

    const collector = new CompletionCollector();

    let addValue = true;

    if (isPropertyNameNode(node)) {
      const parent = node.parent;
      if (parent) {
        // get value node from parent
        const valueNode = getChildValueNode(parent);
        addValue =
          !valueNode ||
          (valueNode.name === TOKENS.INVALID &&
            valueNode.from - valueNode.to === 0);
        debug.log("xxx", "addValue", addValue, getChildValueNode(parent), node);
        // find object node
        node =
          [parent, parent.parent].find((p) => {
            if (p?.name === TOKENS.OBJECT) {
              return true;
            }
            return false;
          }) ?? null;
      }
    }

    debug.log("xxx", node, currentWord, ctx);

    // proposals for properties
    if (
      node &&
      (node.name === TOKENS.OBJECT || node.name === TOKENS.JSON_TEXT) &&
      isPropertyNameNode(getNodeAtPosition(ctx.state, ctx.pos))
    ) {
      // don't suggest keys when the cursor is just before the opening curly brace
      if (node.from === ctx.pos) {
        return result;
      }

      // property proposals with schema
      this.getPropertyCompletions(
        this.schema,
        ctx,
        node,
        collector,
        addValue,
        rawWord
      );
    } else {
      // proposals for values
      const types: { [type: string]: boolean } = {};

      // value proposals with schema
      this.getValueCompletions(this.schema, ctx, types, collector);
    }

    // handle filtering
    result.options = Array.from(collector.completions.values()).filter((v) =>
      stripSurroundingQuotes(v.label).startsWith(prefix)
    );

    debug.log(
      "xxx",
      "result",
      result,
      "prefix",
      prefix,
      "collector.completions",
      collector.completions,
      "reservedKeys",
      collector.reservedKeys
    );
    return result;
  }
  private applySnippetCompletion(completion: Completion) {
    return snippetCompletion(
      typeof completion.apply !== "string"
        ? completion.label
        : completion.apply,
      completion
    );
  }

  private getPropertyCompletions(
    schema: JSONSchema7,
    ctx: CompletionContext,
    node: SyntaxNode,
    collector: CompletionCollector,
    addValue: boolean,
    rawWord: string
  ) {
    // don't suggest properties that are already present
    const properties = node.getChildren(TOKENS.PROPERTY);
    debug.log("xxx", "getPropertyCompletions", node, ctx, properties);
    properties.forEach((p) => {
      const key = getWord(ctx.state.doc, p.getChild(TOKENS.PROPERTY_NAME));
      collector.reserve(stripSurroundingQuotes(key));
    });

    // TODO: Handle separatorAfter

    // Get matching schemas
    const schemas = this.getSchemas(schema, ctx);

    schemas.forEach((s) => {
      if (typeof s !== "object") {
        return;
      }

      const properties = s.properties;
      if (properties) {
        Object.entries(properties).forEach(([key, value]) => {
          if (typeof value === "object") {
            const description = value.description ?? "";
            const type = value.type ?? "";
            const typeStr = Array.isArray(type) ? type.toString() : type;
            const completion: Completion = {
              // label is the unquoted key which will be displayed.
              label: key,
              apply: this.getInsertTextForProperty(
                key,
                addValue,
                rawWord,
                value
              ),
              type: "property",
              detail: typeStr,
              info: description,
            };
            collector.add(this.applySnippetCompletion(completion));
          }
        });
      }
      const propertyNames = s.propertyNames;
      if (typeof propertyNames === "object") {
        if (propertyNames.enum) {
          propertyNames.enum.forEach((v) => {
            const label = v?.toString();
            if (label) {
              const completion: Completion = {
                label,
                apply: this.getInsertTextForProperty(label, addValue, rawWord),
                type: "property",
              };
              collector.add(this.applySnippetCompletion(completion));
            }
          });
        }

        if (propertyNames.const) {
          const label = propertyNames.const.toString();
          const completion: Completion = {
            label,
            apply: this.getInsertTextForProperty(label, addValue, rawWord),
            type: "property",
          };
          collector.add(this.applySnippetCompletion(completion));
        }
      }
    });
  }

  // apply is the quoted key which will be applied.
  // Normally the label needs to match the token
  // prefix i.e. if the token begins with `"to`, then the
  // label needs to have the quotes as well for it to match.
  // However we are manually filtering the results so we can
  // just use the unquoted key as the label, which is nicer
  // and gives us more control.
  // If no property value is present, then we add the colon as well.
  // Use snippetCompletion to handle insert value + position cursor e.g. "key": "#{}"
  // doc: https://codemirror.net/docs/ref/#autocomplete.snippetCompletion
  // idea: https://discuss.codemirror.net/t/autocomplete-cursor-position-in-apply-function/4088/3
  private getInsertTextForProperty(
    key: string,
    addValue: boolean,
    rawWord: string,
    propertySchema?: JSONSchema7Definition
  ) {
    // expand schema property if it is a reference
    propertySchema = propertySchema
      ? this.expandSchemaProperty(propertySchema, this.schema)
      : propertySchema;

    const isJSON5 = this.opts?.mode === "json5";
    let resultText = isJSON5
      ? json5PropertyInsertSnippet(rawWord, key)
      : `"${key}"`;
    if (!addValue) {
      return resultText;
    }
    resultText += ": ";

    let value;
    let nValueProposals = 0;
    if (typeof propertySchema === "object") {
      if (typeof propertySchema.default !== "undefined") {
        if (!value) {
          value = this.getInsertTextForGuessedValue(propertySchema.default, "");
        }
        nValueProposals++;
      } else {
        if (propertySchema.enum) {
          if (!value && propertySchema.enum.length === 1) {
            value = this.getInsertTextForGuessedValue(
              propertySchema.enum[0],
              ""
            );
          }
          nValueProposals += propertySchema.enum.length;
        }
        if (typeof propertySchema.const !== "undefined") {
          if (!value) {
            value = this.getInsertTextForGuessedValue(propertySchema.const, "");
          }
          nValueProposals++;
        }
        if (
          Array.isArray(propertySchema.examples) &&
          propertySchema.examples.length
        ) {
          if (!value) {
            value = this.getInsertTextForGuessedValue(
              propertySchema.examples[0],
              ""
            );
          }
          nValueProposals += propertySchema.examples.length;
        }
        if (value === undefined && nValueProposals === 0) {
          let type = Array.isArray(propertySchema.type)
            ? propertySchema.type[0]
            : propertySchema.type;
          if (!type) {
            if (propertySchema.properties) {
              type = "object";
            } else if (propertySchema.items) {
              type = "array";
            }
          }
          switch (type) {
            case "boolean":
              value = "#{}";
              break;
            case "string":
              value = isJSON5 ? "'#{}'" : '"#{}"';
              break;
            case "object":
              value = "{#{}}";
              break;
            case "array":
              value = "[#{}]";
              break;
            case "number":
            case "integer":
              value = "#{0}";
              break;
            case "null":
              value = "#{null}";
              break;
            default:
              // always advance the cursor after completing a property
              value = "#{}";
              break;
          }
        }
      }
    }
    if (!value || nValueProposals > 1) {
      debug.log(
        "xxx",
        "value",
        value,
        "nValueProposals",
        nValueProposals,
        propertySchema
      );
      value = "#{}";
    }

    return resultText + value;
  }

  private getInsertTextForGuessedValue(
    value: any,
    separatorAfter = ""
  ): string {
    switch (typeof value) {
      case "object":
        if (value === null) {
          return "${null}" + separatorAfter;
        }
        return this.getInsertTextForValue(value, separatorAfter);
      case "string": {
        let snippetValue = JSON.stringify(value);
        snippetValue = snippetValue.substr(1, snippetValue.length - 2); // remove quotes
        snippetValue = this.getInsertTextForPlainText(snippetValue); // escape \ and }
        return '"${' + snippetValue + '}"' + separatorAfter;
      }
      case "number":
      case "boolean":
        return "${" + JSON.stringify(value) + "}" + separatorAfter;
    }
    return this.getInsertTextForValue(value, separatorAfter);
  }
  private getInsertTextForPlainText(text: string): string {
    return text.replace(/[\\$}]/g, "\\$&"); // escape $, \ and }
  }

  private getInsertTextForValue(value: any, separatorAfter: string): string {
    const text = JSON.stringify(value, null, "\t");
    if (text === "{}") {
      return "{#{}}" + separatorAfter;
    } else if (text === "[]") {
      return "[#{}]" + separatorAfter;
    }
    return this.getInsertTextForPlainText(text + separatorAfter);
  }

  private getValueCompletions(
    schema: JSONSchema7,
    ctx: CompletionContext,
    types: { [type: string]: boolean },
    collector: CompletionCollector
  ) {
    let node: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(
      ctx.pos,
      -1
    );
    let valueNode: SyntaxNode | null = null;
    let parentKey: string | undefined = undefined;

    debug.log("xxx", "getValueCompletions", node, ctx);

    if (node && isPrimitiveValueNode(node)) {
      valueNode = node;
      node = node.parent;
    }

    if (!node) {
      this.addSchemaValueCompletions(schema, types, collector);
      return;
    }

    if (node.name === TOKENS.PROPERTY) {
      const keyNode = node.getChild(TOKENS.PROPERTY_NAME);
      if (keyNode) {
        parentKey = getWord(ctx.state.doc, keyNode);
        node = node.parent;
      }
    }

    debug.log("xxx", "node", node, "parentKey", parentKey);
    if (node && (parentKey !== undefined || node.name === TOKENS.ARRAY)) {
      // Get matching schemas
      const schemas = this.getSchemas(schema, ctx);
      for (const s of schemas) {
        if (typeof s !== "object") {
          return;
        }

        if (node.name === TOKENS.ARRAY && s.items) {
          let c = collector;
          if (s.uniqueItems) {
            c = {
              ...c,
              add(completion) {
                if (!c.completions.has(completion.label)) {
                  collector.add(completion);
                }
              },
              reserve(key) {
                collector.reserve(key);
              },
            };
          }
          if (Array.isArray(s.items)) {
            let arrayIndex = 0;
            if (valueNode) {
              // get index of next node in array
              const foundIdx = findNodeIndexInArrayNode(node, valueNode);

              if (foundIdx >= 0) {
                arrayIndex = foundIdx;
              }
            }
            const itemSchema = s.items[arrayIndex];
            if (itemSchema) {
              this.addSchemaValueCompletions(itemSchema, types, c);
            }
          } else {
            this.addSchemaValueCompletions(s.items, types, c);
          }
        }

        if (parentKey !== undefined) {
          let propertyMatched = false;
          if (s.properties) {
            const propertySchema = s.properties[parentKey];
            if (propertySchema) {
              propertyMatched = true;
              this.addSchemaValueCompletions(propertySchema, types, collector);
            }
          }
          if (s.patternProperties && !propertyMatched) {
            for (const pattern of Object.keys(s.patternProperties)) {
              const regex = this.extendedRegExp(pattern);
              if (regex?.test(parentKey)) {
                propertyMatched = true;
                const propertySchema = s.patternProperties[pattern];
                if (propertySchema) {
                  this.addSchemaValueCompletions(
                    propertySchema,
                    types,
                    collector
                  );
                }
              }
            }
          }
          if (s.additionalProperties && !propertyMatched) {
            const propertySchema = s.additionalProperties;
            this.addSchemaValueCompletions(propertySchema, types, collector);
          }
        }
        if (types["boolean"]) {
          this.addBooleanValueCompletion(true, collector);
          this.addBooleanValueCompletion(false, collector);
        }
        if (types["null"]) {
          this.addNullValueCompletion(collector);
        }
      }
    }
  }

  private addSchemaValueCompletions(
    schema: JSONSchema7Definition,
    types: { [type: string]: boolean },
    collector: CompletionCollector
  ) {
    if (typeof schema === "object") {
      this.addEnumValueCompletions(schema, collector);
      this.addDefaultValueCompletions(schema, collector);
      this.collectTypes(schema, types);
      if (Array.isArray(schema.allOf)) {
        schema.allOf.forEach((s) =>
          this.addSchemaValueCompletions(s, types, collector)
        );
      }
      if (Array.isArray(schema.anyOf)) {
        schema.anyOf.forEach((s) =>
          this.addSchemaValueCompletions(s, types, collector)
        );
      }
      if (Array.isArray(schema.oneOf)) {
        schema.oneOf.forEach((s) =>
          this.addSchemaValueCompletions(s, types, collector)
        );
      }
    }
  }
  private addDefaultValueCompletions(
    schema: JSONSchema7,
    collector: CompletionCollector,
    arrayDepth = 0
  ): void {
    let hasProposals = false;
    if (typeof schema.default !== "undefined") {
      let type = schema.type;
      let value = schema.default;
      for (let i = arrayDepth; i > 0; i--) {
        value = [value];
        type = "array";
      }
      const completionItem: Completion = {
        type: type?.toString(),
        label: this.getLabelForValue(value),
        detail: "Default value",
      };
      collector.add(completionItem);
      hasProposals = true;
    }
    if (Array.isArray(schema.examples)) {
      schema.examples.forEach((example) => {
        let type = schema.type;
        let value = example;
        for (let i = arrayDepth; i > 0; i--) {
          value = [value];
          type = "array";
        }
        collector.add({
          type: type?.toString(),
          label: this.getLabelForValue(value),
        });
        hasProposals = true;
      });
    }
    if (
      !hasProposals &&
      typeof schema.items === "object" &&
      !Array.isArray(schema.items) &&
      arrayDepth < 5 /* beware of recursion */
    ) {
      this.addDefaultValueCompletions(schema.items, collector, arrayDepth + 1);
    }
  }

  private addEnumValueCompletions(
    schema: JSONSchema7,
    collector: CompletionCollector
  ): void {
    if (typeof schema.const !== "undefined") {
      collector.add({
        type: schema.type?.toString(),
        label: this.getLabelForValue(schema.const),

        info: schema.description,
      });
    }

    if (Array.isArray(schema.enum)) {
      for (let i = 0, length = schema.enum.length; i < length; i++) {
        const enm = schema.enum[i];
        collector.add({
          type: schema.type?.toString(),
          label: this.getLabelForValue(enm),
          info: schema.description,
        });
      }
    }
  }

  private addBooleanValueCompletion(
    value: boolean,
    collector: CompletionCollector
  ): void {
    collector.add({
      type: "boolean",
      label: value ? "true" : "false",
    });
  }

  private addNullValueCompletion(collector: CompletionCollector): void {
    collector.add({
      type: "null",
      label: "null",
    });
  }

  private collectTypes(
    schema: JSONSchema7,
    types: { [type: string]: boolean }
  ) {
    if (Array.isArray(schema.enum) || typeof schema.const !== "undefined") {
      return;
    }
    const type = schema.type;
    if (Array.isArray(type)) {
      type.forEach((t) => (types[t] = true));
    } else if (type) {
      types[type] = true;
    }
  }

  private getSchemas(
    schema: JSONSchema7,
    ctx: CompletionContext
  ): JSONSchema7Definition[] {
    const draft = new Draft07(this.schema);
    let pointer = jsonPointerForPosition(ctx.state, ctx.pos);
    let subSchema = getSchema(draft, pointer);
    // if we don't have a schema for the current pointer, try the parent pointer
    if (
      !subSchema ||
      subSchema.name === "UnknownPropertyError" ||
      subSchema.enum ||
      subSchema.type === "undefined"
    ) {
      pointer = pointer.replace(/\/[^/]*$/, "/");
      subSchema = getSchema(draft, pointer);
    }

    debug.log("xxx", "pointer..", JSON.stringify(pointer));

    // For some reason, it returns undefined schema for the root pointer
    if (!pointer || pointer === "/") {
      return [schema];
    }
    // const subSchema = new Draft07(this.schema).getSchema(pointer);
    debug.log("xxx", "subSchema..", subSchema);

    if (this.isJsonError(subSchema)) {
      return [];
    }

    if (Array.isArray(subSchema.allOf)) {
      return [
        subSchema,
        ...subSchema.allOf.map((s) => this.expandSchemaProperty(s, schema)),
      ];
    }
    if (Array.isArray(subSchema.oneOf)) {
      return [
        subSchema,
        ...subSchema.oneOf.map((s) => this.expandSchemaProperty(s, schema)),
      ];
    }
    if (Array.isArray(subSchema.anyOf)) {
      return [
        subSchema,
        ...subSchema.anyOf.map((s) => this.expandSchemaProperty(s, schema)),
      ];
    }

    return [subSchema as JSONSchema7];
  }

  isJsonError(d: JSONSchema7 | JsonError): d is JsonError {
    return d.type === "error";
  }

  private expandSchemaProperty(
    property: JSONSchema7Definition,
    schema: JSONSchema7
  ) {
    if (typeof property === "object" && property.$ref) {
      const refSchema = this.getReferenceSchema(schema, property.$ref);
      if (typeof refSchema === "object") {
        const dereferenced = {
          ...property,
          ...refSchema,
        };
        Reflect.deleteProperty(dereferenced, "$ref");

        return dereferenced;
      }
    }
    return property;
  }

  private getReferenceSchema(schema: JSONSchema7, ref: string) {
    const refPath = ref.split("/");
    let curReference: Record<string, any> | undefined = schema;
    refPath.forEach((cur) => {
      if (!cur) {
        return;
      }
      if (cur === "#") {
        curReference = schema;
        return;
      }
      if (typeof curReference === "object") {
        curReference = curReference[cur];
      }
    });

    return curReference;
  }

  private getLabelForValue(value: any): string {
    return JSON.stringify(value);
  }

  private getValueFromLabel(value: any): string {
    return JSON.parse(value);
  }

  private extendedRegExp(pattern: string): RegExp | undefined {
    let flags = "";
    if (pattern.startsWith("(?i)")) {
      pattern = pattern.substring(4);
      flags = "i";
    }
    try {
      return new RegExp(pattern, flags + "u");
    } catch (e) {
      // could be an exception due to the 'u ' flag
      try {
        return new RegExp(pattern, flags);
      } catch (e) {
        // invalid pattern
        return undefined;
      }
    }
  }
}
/**
 * provides a JSON schema enabled autocomplete extension for codemirror
 * @group Codemirror Extensions
 */
export function jsonCompletion(
  schema: JSONSchema7,
  opts: JSONCompletionOptions = {}
) {
  const completion = new JSONCompletion(schema, opts);
  return function jsonDoCompletion(ctx: CompletionContext) {
    return completion.doComplete(ctx);
  };
}

/**
 * provides a JSON schema enabled autocomplete extension for codemirror and json5
 * @group Codemirror Extensions
 */
export function json5Completion(
  schema: JSONSchema7,
  opts: Omit<JSONCompletionOptions, "mode"> = {}
) {
  const completion = new JSONCompletion(schema, { ...opts, mode: "json5" });
  return function jsonDoCompletion(ctx: CompletionContext) {
    return completion.doComplete(ctx);
  };
}
