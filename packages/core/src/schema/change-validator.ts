/**
 * Change Validator — Validates and previews schema changes before execution.
 *
 * This module ensures that proposed schema changes won't corrupt data,
 * break relationships, or leave the database in an inconsistent state.
 * It generates human-readable previews and actionable warnings/errors.
 */

import { buildCheckConstraints } from './check-constraints.js';
import type { DdlExecutor } from './ddl-executor.js';
import type { SchemaRegistry } from './schema-registry.js';
import { type TypeChangePrecheck, assessTypeChange } from './type-compat.js';
import type {
  ChangeError,
  ChangePreview,
  ChangeSet,
  ChangeWarning,
  DataObjectDefinition,
  FieldDefinition,
  FieldModification,
  SchemaChange,
} from './types.js';
import {
  COLUMN_TYPES,
  type ColumnTypeName,
  PRESENTATION_ONLY_KEYS,
  managedByBlock,
} from './types.js';

/** Shape of the per-change validation result the private validators return. */
interface ValidationResult {
  warnings: ChangeWarning[];
  errors: ChangeError[];
  sqlStatements: string[];
}

export class ChangeValidator {
  constructor(
    private readonly registry: SchemaRegistry,
    private readonly ddlExecutor: DdlExecutor,
  ) {}

  /**
   * Validates a proposed change set and generates a preview.
   * This is called before any schema changes are applied.
   *
   * Returns a ChangePreview with:
   * - The SQL statements that would be executed
   * - Any warnings (e.g., "this column has data that may be lost")
   * - Any errors that would prevent the change from being applied
   */
  async validateChangeSet(changeSet: ChangeSet): Promise<ChangePreview> {
    const warnings: ChangeWarning[] = [];
    const errors: ChangeError[] = [];
    const sqlStatements: string[] = [];

    for (const change of changeSet.changes) {
      const result = await this.validateChange(change);
      warnings.push(...result.warnings);
      errors.push(...result.errors);
      sqlStatements.push(...result.sqlStatements);
    }

    return {
      changeSet,
      sqlStatements,
      warnings,
      errors,
      isValid: errors.length === 0,
    };
  }

  private async validateChange(change: SchemaChange): Promise<{
    warnings: ChangeWarning[];
    errors: ChangeError[];
    sqlStatements: string[];
  }> {
    switch (change.type) {
      case 'create_object':
        return this.validateCreateObject(change);
      case 'delete_object':
        return this.validateDeleteObject(change);
      case 'add_field':
        return this.validateAddField(change);
      case 'remove_field':
        return this.validateRemoveField(change);
      case 'modify_field':
        return this.validateModifyField(change);
      case 'rename_field':
        return this.validateRenameField(change);
      case 'add_relationship':
        return this.validateAddRelationship(change);
      case 'remove_relationship':
        return this.validateRemoveRelationship(change);
      default:
        return {
          warnings: [],
          errors: [
            {
              change,
              message: `Unknown change type: ${change.type}`,
              code: 'UNKNOWN_CHANGE_TYPE',
            },
          ],
          sqlStatements: [],
        };
    }
  }

  // -------------------------------------------------------------------------
  // Validation for each change type
  // -------------------------------------------------------------------------

  private async validateCreateObject(change: SchemaChange): Promise<{
    warnings: ChangeWarning[];
    errors: ChangeError[];
    sqlStatements: string[];
  }> {
    const warnings: ChangeWarning[] = [];
    const errors: ChangeError[] = [];
    const definition = change.details as unknown as DataObjectDefinition;

    // Check if name already exists
    if (this.registry.objectExists(change.objectName)) {
      errors.push({
        change,
        message: `Data object "${change.objectName}" already exists`,
        code: 'OBJECT_EXISTS',
      });
    }

    // Validate object name format (lowercase, underscores, no spaces)
    if (!/^[a-z][a-z0-9_]*$/.test(change.objectName)) {
      errors.push({
        change,
        message: `Invalid object name "${change.objectName}". Must start with a letter and contain only lowercase letters, numbers, and underscores.`,
        code: 'INVALID_NAME',
      });
    }

    // Validate field types
    if (definition?.fields) {
      for (const field of definition.fields) {
        if (!COLUMN_TYPES[field.columnType as ColumnTypeName]) {
          errors.push({
            change,
            message: `Unknown column type "${field.columnType}" for field "${field.name}"`,
            code: 'INVALID_COLUMN_TYPE',
          });
        }
      }
    }

    // Check if table exists in database (could be a leftover)
    const tableName = definition?.tableName ?? change.objectName;
    const tableExists = await this.ddlExecutor.tableExists(tableName);
    if (tableExists) {
      warnings.push({
        change,
        message: `Table "${tableName}" already exists in the database. It will be used as-is.`,
        severity: 'high',
      });
    }

    const sqlStatements = [`CREATE TABLE "${tableName}" (...)`];
    return { warnings, errors, sqlStatements };
  }

  private async validateDeleteObject(change: SchemaChange): Promise<{
    warnings: ChangeWarning[];
    errors: ChangeError[];
    sqlStatements: string[];
  }> {
    const warnings: ChangeWarning[] = [];
    const errors: ChangeError[] = [];

    const obj = this.registry.getObject(change.objectName);
    if (!obj) {
      errors.push({
        change,
        message: `Data object "${change.objectName}" does not exist`,
        code: 'OBJECT_NOT_FOUND',
      });
      return { warnings, errors, sqlStatements: [] };
    }

    if (obj.isSystem) {
      errors.push({
        change,
        message: `Cannot delete system object "${change.objectName}"`,
        code: 'CANNOT_DELETE_SYSTEM',
      });
    }

    // Check for dependent relationships
    const relationships = this.registry.getRelationships(change.objectName);
    if (relationships.length > 0) {
      const relNames = relationships.map((r) => r.name).join(', ');
      warnings.push({
        change,
        message: `Deleting "${change.objectName}" will remove ${relationships.length} relationship(s): ${relNames}`,
        severity: 'high',
      });
    }

    // Check for data
    const rowCount = await this.ddlExecutor.getRowCount(obj.tableName);
    if (rowCount > 0) {
      warnings.push({
        change,
        message: `Table "${obj.tableName}" contains ${rowCount} row(s). All data will be permanently deleted.`,
        severity: 'high',
      });
    }

    return {
      warnings,
      errors,
      sqlStatements: [`DROP TABLE IF EXISTS "${obj.tableName}" CASCADE`],
    };
  }

  private async validateAddField(change: SchemaChange): Promise<{
    warnings: ChangeWarning[];
    errors: ChangeError[];
    sqlStatements: string[];
  }> {
    const warnings: ChangeWarning[] = [];
    const errors: ChangeError[] = [];
    const field = change.details as unknown as FieldDefinition;

    const obj = this.registry.getObject(change.objectName);
    if (!obj) {
      errors.push({
        change,
        message: `Data object "${change.objectName}" does not exist`,
        code: 'OBJECT_NOT_FOUND',
      });
      return { warnings, errors, sqlStatements: [] };
    }

    // Check for duplicate field name
    const existingField = obj.fields.find((f) => f.name === field?.name);
    if (existingField) {
      errors.push({
        change,
        message: `Field "${field?.name}" already exists on "${change.objectName}"`,
        code: 'FIELD_EXISTS',
      });
    }

    // Validate column type
    if (field && !COLUMN_TYPES[field.columnType as ColumnTypeName]) {
      errors.push({
        change,
        message: `Unknown column type "${field.columnType}" for field "${field.name}"`,
        code: 'INVALID_COLUMN_TYPE',
      });
    }

    // Check if adding a required field to a non-empty table
    if (field?.isRequired && !field.defaultValue) {
      const rowCount = await this.ddlExecutor.getRowCount(obj.tableName);
      if (rowCount > 0) {
        warnings.push({
          change,
          message: `Adding required field "${field.name}" to "${change.objectName}" with ${rowCount} existing rows. A default value will be assigned.`,
          severity: 'medium',
        });
      }
    }

    const columnName = field?.columnName ?? field?.name;
    return {
      warnings,
      errors,
      sqlStatements: [`ALTER TABLE "${obj.tableName}" ADD COLUMN "${columnName}" ...`],
    };
  }

  private async validateRemoveField(change: SchemaChange): Promise<{
    warnings: ChangeWarning[];
    errors: ChangeError[];
    sqlStatements: string[];
  }> {
    const warnings: ChangeWarning[] = [];
    const errors: ChangeError[] = [];
    const fieldName = change.details.fieldName as string;

    const obj = this.registry.getObject(change.objectName);
    if (!obj) {
      errors.push({
        change,
        message: `Data object "${change.objectName}" does not exist`,
        code: 'OBJECT_NOT_FOUND',
      });
      return { warnings, errors, sqlStatements: [] };
    }

    const field = obj.fields.find((f) => f.name === fieldName);
    if (!field) {
      errors.push({
        change,
        message: `Field "${fieldName}" does not exist on "${change.objectName}"`,
        code: 'FIELD_NOT_FOUND',
      });
      return { warnings, errors, sqlStatements: [] };
    }

    if (field.isSystem) {
      errors.push({
        change,
        message: `Cannot remove system field "${fieldName}" from "${change.objectName}"`,
        code: 'CANNOT_REMOVE_SYSTEM_FIELD',
      });
    }

    if (field.isPrimary) {
      errors.push({
        change,
        message: `Cannot remove primary key field "${fieldName}" from "${change.objectName}"`,
        code: 'CANNOT_REMOVE_PRIMARY_KEY',
      });
    }

    // Contract protection (ADR-017): block-managed fields resist removal.
    const owningBlock = managedByBlock(field.managedBy);
    if (owningBlock) {
      if (change.details.force === true) {
        warnings.push({
          change,
          message: `Field "${fieldName}" is managed by the "${owningBlock}" block; forcing its removal may break that block.`,
          severity: 'high',
        });
      } else {
        errors.push({
          change,
          message: `Field "${fieldName}" is managed by the "${owningBlock}" block. Removing it would break the block's contract — pass force=true to override.`,
          code: 'BLOCK_MANAGED_FIELD',
        });
      }
    }

    // Check for data loss
    const hasData = await this.ddlExecutor.columnHasData(obj.tableName, field.columnName);
    if (hasData) {
      warnings.push({
        change,
        message: `Column "${field.columnName}" in "${obj.tableName}" contains data. Removing this field will permanently delete that data.`,
        severity: 'high',
      });
    }

    // Check if this field is used in any relationships
    const relationships = this.registry.getRelationships(change.objectName);
    const relUsingField = relationships.filter(
      (r) => r.sourceFieldName === fieldName || r.targetFieldName === fieldName,
    );
    if (relUsingField.length > 0) {
      errors.push({
        change,
        message: `Field "${fieldName}" is used in relationship(s): ${relUsingField.map((r) => r.name).join(', ')}. Remove the relationship(s) first.`,
        code: 'FIELD_IN_RELATIONSHIP',
      });
    }

    return {
      warnings,
      errors,
      sqlStatements: [`ALTER TABLE "${obj.tableName}" DROP COLUMN "${field.columnName}"`],
    };
  }

  /**
   * Validates a `modify_field` change (details: `{ fieldName, updates, force? }`).
   *
   * Beyond existence/system checks this runs the Phase 10 safety analysis:
   * - type changes go through the compatible-type matrix and, when the matrix
   *   demands it, a data pre-check (max text length / numeric range);
   * - `isUnique: true` pre-checks for duplicate values;
   * - `isRequired: true` pre-checks for NULLs and requires a backfill value;
   * - structural changes to block-managed fields are rejected unless forced.
   */
  private async validateModifyField(change: SchemaChange): Promise<ValidationResult> {
    const warnings: ChangeWarning[] = [];
    const errors: ChangeError[] = [];
    const sqlStatements: string[] = [];

    const obj = this.registry.getObject(change.objectName);
    if (!obj) {
      errors.push({
        change,
        message: `Data object "${change.objectName}" does not exist`,
        code: 'OBJECT_NOT_FOUND',
      });
      return { warnings, errors, sqlStatements };
    }

    const fieldName = change.details.fieldName as string;
    const updates = (change.details.updates ?? {}) as FieldModification;
    const force = change.details.force === true;

    const field = obj.fields.find((f) => f.name === fieldName);
    if (!field) {
      errors.push({
        change,
        message: `Field "${fieldName}" does not exist on "${change.objectName}"`,
        code: 'FIELD_NOT_FOUND',
      });
      return { warnings, errors, sqlStatements };
    }

    if (field.isSystem || field.isPrimary) {
      errors.push({
        change,
        message: `Cannot modify system field "${fieldName}" on "${change.objectName}"`,
        code: 'CANNOT_MODIFY_SYSTEM_FIELD',
      });
      return { warnings, errors, sqlStatements };
    }

    this.checkBlockProtection(change, field, updates, force, errors, warnings);
    this.checkRename(change, obj, field, updates, errors, warnings, sqlStatements);
    await this.checkTypeChange(change, obj, field, updates, errors, warnings, sqlStatements);
    await this.checkUniqueToggle(change, obj, field, updates, errors, sqlStatements);
    await this.checkRequiredToggle(change, obj, field, updates, errors, warnings, sqlStatements);
    await this.checkConstraintChange(change, obj, field, updates, errors, sqlStatements);

    if (updates.defaultValue !== undefined) {
      sqlStatements.push(
        updates.defaultValue === null || updates.defaultValue === ''
          ? `ALTER TABLE "${obj.tableName}" ALTER COLUMN "${field.columnName}" DROP DEFAULT`
          : `ALTER TABLE "${obj.tableName}" ALTER COLUMN "${field.columnName}" SET DEFAULT ...`,
      );
    }
    if (updates.isIndexed !== undefined && updates.isIndexed !== (field.isIndexed ?? false)) {
      const indexName = `idx_${obj.tableName}_${field.columnName}`;
      sqlStatements.push(
        updates.isIndexed
          ? `CREATE INDEX "${indexName}" ON "${obj.tableName}" ("${field.columnName}")`
          : `DROP INDEX IF EXISTS "${indexName}"`,
      );
    }

    return { warnings, errors, sqlStatements };
  }

  /** Rejects structural updates to block-managed fields unless forced (ADR-017). */
  private checkBlockProtection(
    change: SchemaChange,
    field: FieldDefinition,
    updates: FieldModification,
    force: boolean,
    errors: ChangeError[],
    warnings: ChangeWarning[],
  ): void {
    const owningBlock = managedByBlock(field.managedBy);
    if (!owningBlock) return;

    const structuralKeys = (Object.keys(updates) as (keyof FieldModification)[]).filter(
      (key) =>
        updates[key] !== undefined && !PRESENTATION_ONLY_KEYS.has(key) && key !== 'backfillValue',
    );
    if (structuralKeys.length === 0) return;

    if (force) {
      warnings.push({
        change,
        message: `Field "${field.name}" is managed by the "${owningBlock}" block; forcing a structural change (${structuralKeys.join(', ')}) may break that block.`,
        severity: 'high',
      });
      return;
    }
    errors.push({
      change,
      message: `Field "${field.name}" is managed by the "${owningBlock}" block. Structural changes (${structuralKeys.join(', ')}) would break the block's contract — pass force=true to override.`,
      code: 'BLOCK_MANAGED_FIELD',
    });
  }

  /** Validates a rename embedded in a modification (`updates.name`). */
  private checkRename(
    change: SchemaChange,
    obj: DataObjectDefinition,
    field: FieldDefinition,
    updates: FieldModification,
    errors: ChangeError[],
    warnings: ChangeWarning[],
    sqlStatements: string[],
  ): void {
    if (updates.name === undefined || updates.name === field.name) return;

    if (!/^[a-z][a-z0-9_]*$/.test(updates.name)) {
      errors.push({
        change,
        message: `Invalid field name "${updates.name}". Must start with a letter and contain only lowercase letters, numbers, and underscores.`,
        code: 'INVALID_NAME',
      });
    }
    if (obj.fields.some((f) => f.name === updates.name)) {
      errors.push({
        change,
        message: `Field "${updates.name}" already exists on "${change.objectName}"`,
        code: 'FIELD_EXISTS',
      });
    }
    warnings.push({
      change,
      message: `Renaming "${field.name}" to "${updates.name}" changes the public API: REST filter keys, GraphQL fields, and MCP tool arguments that reference the old name will break.`,
      severity: 'medium',
    });
    sqlStatements.push(
      `ALTER TABLE "${obj.tableName}" RENAME COLUMN "${field.columnName}" TO "${updates.name}"`,
    );
  }

  /** Runs the compatible-type matrix + any required data pre-check. */
  private async checkTypeChange(
    change: SchemaChange,
    obj: DataObjectDefinition,
    field: FieldDefinition,
    updates: FieldModification,
    errors: ChangeError[],
    warnings: ChangeWarning[],
    sqlStatements: string[],
  ): Promise<void> {
    if (updates.columnType === undefined || updates.columnType === field.columnType) return;

    if (!COLUMN_TYPES[updates.columnType as ColumnTypeName]) {
      errors.push({
        change,
        message: `Unknown column type "${updates.columnType}"`,
        code: 'INVALID_COLUMN_TYPE',
      });
      return;
    }

    const assessment = assessTypeChange(field.columnType, updates.columnType);
    if (!assessment.compatible) {
      errors.push({ change, message: assessment.reason, code: 'TYPE_INCOMPATIBLE' });
      return;
    }

    if (assessment.level === 'warn' && assessment.message) {
      warnings.push({ change, message: assessment.message, severity: 'medium' });
    }

    if (assessment.precheck) {
      const violation = await this.runTypePrecheck(obj, field, assessment.precheck);
      if (violation) {
        errors.push({ change, message: violation, code: 'DATA_INCOMPATIBLE' });
      }
    }

    const targetPg = COLUMN_TYPES[updates.columnType].pg;
    const using = assessment.usingCast ? ` USING "${field.columnName}"${assessment.usingCast}` : '';
    sqlStatements.push(
      `ALTER TABLE "${obj.tableName}" ALTER COLUMN "${field.columnName}" TYPE ${targetPg}${using}`,
    );
  }

  /** Executes a matrix-mandated data pre-check; returns an error message on violation. */
  private async runTypePrecheck(
    obj: DataObjectDefinition,
    field: FieldDefinition,
    precheck: TypeChangePrecheck,
  ): Promise<string | null> {
    if (precheck.kind === 'max_text_length') {
      const maxLen = await this.ddlExecutor.getMaxTextLength(obj.tableName, field.columnName);
      if (maxLen > precheck.limit) {
        return `Existing values in "${field.name}" are up to ${maxLen} characters long, exceeding the ${precheck.limit}-character limit of the target type.`;
      }
      return null;
    }
    const outOfRange = await this.ddlExecutor.countOutOfRange(
      obj.tableName,
      field.columnName,
      precheck.min,
      precheck.max,
    );
    if (outOfRange > 0) {
      return `${outOfRange} existing row(s) in "${field.name}" fall outside the target type's range (${precheck.min}..${precheck.max}).`;
    }
    return null;
  }

  /**
   * Pre-validates existing rows against changed field constraints (Phase 10):
   * tightening a min/max/pattern/enum rule must not strand data that the new
   * CHECK constraint would reject. This is also the migration path for
   * pre-Phase-10 enum fields (validate-then-add-constraint, via this preview).
   */
  private async checkConstraintChange(
    change: SchemaChange,
    obj: DataObjectDefinition,
    field: FieldDefinition,
    updates: FieldModification,
    errors: ChangeError[],
    sqlStatements: string[],
  ): Promise<void> {
    if (updates.constraints === undefined) return;

    if (updates.constraints === null) {
      if (field.constraints) {
        sqlStatements.push(`ALTER TABLE "${obj.tableName}" DROP CONSTRAINT /* ion_ck_* */ ...`);
      }
      return;
    }

    const effectiveType = updates.columnType ?? field.columnType;
    const specs = buildCheckConstraints(
      obj.tableName,
      field.columnName,
      effectiveType,
      updates.constraints,
    );

    for (const spec of specs) {
      const violations = await this.ddlExecutor.countCheckViolations(obj.tableName, spec);
      if (violations > 0) {
        errors.push({
          change,
          message: `${violations} existing row(s) in "${field.name}" violate the new ${spec.kind} constraint (${spec.expression}). Fix the data first, or loosen the rule.`,
          code: 'CONSTRAINT_VIOLATIONS',
        });
      }
      sqlStatements.push(
        `ALTER TABLE "${obj.tableName}" ADD CONSTRAINT "${spec.name}" CHECK (${spec.expression})`,
      );
    }
  }

  /** Pre-checks duplicates when toggling `isUnique` on. */
  private async checkUniqueToggle(
    change: SchemaChange,
    obj: DataObjectDefinition,
    field: FieldDefinition,
    updates: FieldModification,
    errors: ChangeError[],
    sqlStatements: string[],
  ): Promise<void> {
    if (updates.isUnique === undefined || updates.isUnique === (field.isUnique ?? false)) return;

    if (!updates.isUnique) {
      sqlStatements.push(`ALTER TABLE "${obj.tableName}" DROP CONSTRAINT /* unique */ ...`);
      return;
    }

    const duplicates = await this.ddlExecutor.findDuplicateValues(obj.tableName, field.columnName);
    if (duplicates.length > 0) {
      const samples = duplicates.map((d) => `"${d.value}" (×${d.count})`).join(', ');
      errors.push({
        change,
        message: `Cannot make "${field.name}" unique: existing duplicate values found — ${samples}. Deduplicate the data first.`,
        code: 'DUPLICATE_VALUES',
      });
    }
    sqlStatements.push(
      `ALTER TABLE "${obj.tableName}" ADD CONSTRAINT "ion_uq_${obj.tableName}_${field.columnName}" UNIQUE ("${field.columnName}")`,
    );
  }

  /** Pre-checks NULLs (and requires a backfill) when toggling `isRequired` on. */
  private async checkRequiredToggle(
    change: SchemaChange,
    obj: DataObjectDefinition,
    field: FieldDefinition,
    updates: FieldModification,
    errors: ChangeError[],
    warnings: ChangeWarning[],
    sqlStatements: string[],
  ): Promise<void> {
    if (updates.isRequired === undefined || updates.isRequired === (field.isRequired ?? false)) {
      return;
    }

    if (!updates.isRequired) {
      sqlStatements.push(
        `ALTER TABLE "${obj.tableName}" ALTER COLUMN "${field.columnName}" DROP NOT NULL`,
      );
      return;
    }

    const nullCount = await this.ddlExecutor.countNulls(obj.tableName, field.columnName);
    if (nullCount > 0) {
      if (updates.backfillValue === undefined) {
        errors.push({
          change,
          message: `Cannot make "${field.name}" required: ${nullCount} existing row(s) have no value. Provide a backfillValue to fill them.`,
          code: 'REQUIRES_BACKFILL',
        });
      } else {
        warnings.push({
          change,
          message: `${nullCount} row(s) with no value in "${field.name}" will be set to "${updates.backfillValue}".`,
          severity: 'medium',
        });
        sqlStatements.push(
          `UPDATE "${obj.tableName}" SET "${field.columnName}" = ... WHERE "${field.columnName}" IS NULL`,
        );
      }
    }
    sqlStatements.push(
      `ALTER TABLE "${obj.tableName}" ALTER COLUMN "${field.columnName}" SET NOT NULL`,
    );
  }

  private validateRenameField(change: SchemaChange): Promise<{
    warnings: ChangeWarning[];
    errors: ChangeError[];
    sqlStatements: string[];
  }> {
    const warnings: ChangeWarning[] = [];
    const errors: ChangeError[] = [];

    const obj = this.registry.getObject(change.objectName);
    if (!obj) {
      errors.push({
        change,
        message: `Data object "${change.objectName}" does not exist`,
        code: 'OBJECT_NOT_FOUND',
      });
      return Promise.resolve({ warnings, errors, sqlStatements: [] });
    }

    const oldName = change.details.oldName as string;
    const newName = change.details.newName as string;

    const field = obj.fields.find((f) => f.name === oldName);
    if (!field) {
      errors.push({
        change,
        message: `Field "${oldName}" does not exist on "${change.objectName}"`,
        code: 'FIELD_NOT_FOUND',
      });
    }

    if (field?.isSystem) {
      errors.push({
        change,
        message: `Cannot rename system field "${oldName}" on "${change.objectName}"`,
        code: 'CANNOT_RENAME_SYSTEM_FIELD',
      });
    }

    const owningBlock = managedByBlock(field?.managedBy);
    if (owningBlock && change.details.force !== true) {
      errors.push({
        change,
        message: `Field "${oldName}" is managed by the "${owningBlock}" block. Renaming it would break the block's contract — pass force=true to override.`,
        code: 'BLOCK_MANAGED_FIELD',
      });
    }

    const duplicate = obj.fields.find((f) => f.name === newName);
    if (duplicate) {
      errors.push({
        change,
        message: `Field "${newName}" already exists on "${change.objectName}"`,
        code: 'FIELD_EXISTS',
      });
    }

    return Promise.resolve({
      warnings,
      errors,
      sqlStatements: [`ALTER TABLE "${obj.tableName}" RENAME COLUMN "${oldName}" TO "${newName}"`],
    });
  }

  private validateAddRelationship(change: SchemaChange): Promise<{
    warnings: ChangeWarning[];
    errors: ChangeError[];
    sqlStatements: string[];
  }> {
    const warnings: ChangeWarning[] = [];
    const errors: ChangeError[] = [];

    const relName = change.details.name as string;
    const relType = change.details.type as string;
    const targetObjectName = change.details.targetObjectName as string;

    if (!this.registry.objectExists(change.objectName)) {
      errors.push({
        change,
        message: `Source object "${change.objectName}" does not exist`,
        code: 'OBJECT_NOT_FOUND',
      });
    }

    if (!this.registry.objectExists(targetObjectName)) {
      errors.push({
        change,
        message: `Target object "${targetObjectName}" does not exist`,
        code: 'OBJECT_NOT_FOUND',
      });
    }

    // Relationship names are scoped per source object (the FK column is
    // `<name>_id` on the holding side), so only a same-source duplicate clashes.
    const duplicate = this.registry
      .getAllRelationships()
      .some((r) => r.name === relName && r.sourceObjectName === change.objectName);
    if (duplicate) {
      errors.push({
        change,
        message: `A relationship named "${relName}" already exists on "${change.objectName}"`,
        code: 'RELATIONSHIP_EXISTS',
      });
    }

    // The FK column this relationship would create must not collide with an
    // existing field on whichever object holds the FK.
    if (relType !== 'many_to_many' && relName) {
      const fkObjectName = relType === 'one_to_many' ? targetObjectName : change.objectName;
      const fkObj = this.registry.getObject(fkObjectName);
      const fkColumn = `${relName}_id`;
      if (fkObj?.fields.some((f) => f.columnName === fkColumn)) {
        errors.push({
          change,
          message: `Column "${fkColumn}" already exists on "${fkObjectName}" — pick a different relationship name`,
          code: 'FIELD_EXISTS',
        });
      }
    }

    return Promise.resolve({
      warnings,
      errors,
      sqlStatements: ['ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ...'],
    });
  }

  /**
   * Validates a `remove_relationship` change (details: `{ relationshipName,
   * force? }`; objectName is the relationship's **source** object — names are
   * scoped per source). Produces the real DDL and data-loss warnings; block
   * ownership (the FK field's provenance, or — for many_to_many, which stamps
   * no field — both endpoint objects being block-managed) requires force.
   */
  private async validateRemoveRelationship(change: SchemaChange): Promise<ValidationResult> {
    const warnings: ChangeWarning[] = [];
    const errors: ChangeError[] = [];
    const sqlStatements: string[] = [];

    const relName = change.details.relationshipName as string;
    const force = change.details.force === true;

    const rel = this.registry
      .getAllRelationships()
      .find((r) => r.name === relName && r.sourceObjectName === change.objectName);
    if (!rel) {
      errors.push({
        change,
        message: `Relationship "${relName}" does not exist on "${change.objectName}"`,
        code: 'RELATIONSHIP_NOT_FOUND',
      });
      return { warnings, errors, sqlStatements };
    }

    const sourceObj = this.registry.getObject(rel.sourceObjectName);
    const targetObj = this.registry.getObject(rel.targetObjectName);
    if (!sourceObj || !targetObj) {
      errors.push({
        change,
        message: `Relationship "${relName}" references a missing object`,
        code: 'OBJECT_NOT_FOUND',
      });
      return { warnings, errors, sqlStatements };
    }

    if (rel.type === 'many_to_many') {
      // No FK field carries provenance for m2m; a relationship whose both
      // endpoints are block-managed is treated as block-owned (blocks only
      // declare relationships among their own/dependency objects).
      const sourceBlock = managedByBlock(sourceObj.managedBy);
      const targetBlock = managedByBlock(targetObj.managedBy);
      const owningBlock = sourceBlock && targetBlock ? sourceBlock : undefined;
      this.pushRelationshipProtection(change, owningBlock, relName, force, errors, warnings);

      const junction = rel.junctionTable ?? `${sourceObj.tableName}_${targetObj.tableName}`;
      if (await this.ddlExecutor.tableExists(junction)) {
        const links = await this.ddlExecutor.getRowCount(junction);
        if (links > 0) {
          warnings.push({
            change,
            message: `${links} link row(s) in "${junction}" will be permanently deleted.`,
            severity: 'high',
          });
        }
      }
      sqlStatements.push(`DROP TABLE IF EXISTS "${junction}"`);
    } else {
      // The FK column lives on the "many" side (target for one_to_many).
      const fkObj = rel.type === 'one_to_many' ? targetObj : sourceObj;
      const fkColumn = `${rel.name}_id`;
      const fkField = fkObj.fields.find((f) => f.columnName === fkColumn);
      this.pushRelationshipProtection(
        change,
        managedByBlock(fkField?.managedBy),
        relName,
        force,
        errors,
        warnings,
      );

      if (fkField && (await this.ddlExecutor.columnHasData(fkObj.tableName, fkColumn))) {
        warnings.push({
          change,
          message: `Column "${fkColumn}" on "${fkObj.tableName}" contains linked ids — dropping the relationship permanently removes those links.`,
          severity: 'high',
        });
      }
      sqlStatements.push(`ALTER TABLE "${fkObj.tableName}" DROP COLUMN "${fkColumn}"`);
    }

    return { warnings, errors, sqlStatements };
  }

  /** Contract protection for relationships (ADR-017 pattern, Phase 13). */
  private pushRelationshipProtection(
    change: SchemaChange,
    owningBlock: string | null | undefined,
    relName: string,
    force: boolean,
    errors: ChangeError[],
    warnings: ChangeWarning[],
  ): void {
    if (!owningBlock) return;
    if (force) {
      warnings.push({
        change,
        message: `Relationship "${relName}" belongs to the "${owningBlock}" block; forcing its removal may break that block.`,
        severity: 'high',
      });
      return;
    }
    errors.push({
      change,
      message: `Relationship "${relName}" belongs to the "${owningBlock}" block. Removing it would break the block's contract — pass force=true to override.`,
      code: 'BLOCK_MANAGED_RELATIONSHIP',
    });
  }
}
