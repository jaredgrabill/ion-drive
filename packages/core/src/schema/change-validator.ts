/**
 * Change Validator — Validates and previews schema changes before execution.
 *
 * This module ensures that proposed schema changes won't corrupt data,
 * break relationships, or leave the database in an inconsistent state.
 * It generates human-readable previews and actionable warnings/errors.
 */

import type { DdlExecutor } from './ddl-executor.js';
import type { SchemaRegistry } from './schema-registry.js';
import type {
  ChangeError,
  ChangePreview,
  ChangeSet,
  ChangeWarning,
  DataObjectDefinition,
  FieldDefinition,
  SchemaChange,
} from './types.js';
import { COLUMN_TYPES, type ColumnTypeName } from './types.js';

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

  private async validateModifyField(change: SchemaChange): Promise<{
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

    const fieldName = change.details.fieldName as string;
    const field = obj.fields.find((f) => f.name === fieldName);
    if (!field) {
      errors.push({
        change,
        message: `Field "${fieldName}" does not exist on "${change.objectName}"`,
        code: 'FIELD_NOT_FOUND',
      });
    }

    if (field?.isSystem) {
      errors.push({
        change,
        message: `Cannot modify system field "${fieldName}" on "${change.objectName}"`,
        code: 'CANNOT_MODIFY_SYSTEM_FIELD',
      });
    }

    return {
      warnings,
      errors,
      sqlStatements: [`ALTER TABLE "${obj.tableName}" ALTER COLUMN "${field?.columnName}" ...`],
    };
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

    return Promise.resolve({
      warnings,
      errors,
      sqlStatements: ['ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ...'],
    });
  }

  private validateRemoveRelationship(change: SchemaChange): Promise<{
    warnings: ChangeWarning[];
    errors: ChangeError[];
    sqlStatements: string[];
  }> {
    const warnings: ChangeWarning[] = [];
    const errors: ChangeError[] = [];

    const relName = change.details.relationshipName as string;
    const allRels = this.registry.getAllRelationships();
    const rel = allRels.find((r) => r.name === relName);

    if (!rel) {
      errors.push({
        change,
        message: `Relationship "${relName}" does not exist`,
        code: 'RELATIONSHIP_NOT_FOUND',
      });
    }

    return Promise.resolve({
      warnings,
      errors,
      sqlStatements: ['ALTER TABLE ... DROP CONSTRAINT ...'],
    });
  }
}
