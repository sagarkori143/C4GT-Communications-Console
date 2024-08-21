const searchAsync = require("../utils/routerManager");
const { v4: uuidv4 } = require("uuid");
// const User = require("../models/userModel");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { createErrorResponse } = require("../utils/errorResponse");
const createUserModel = require("../models/userModel");

let fields = [];
let validFields = [];
let config = null;
let properties;

// Function to fetch schema from a URL
async function fetchSchemaFromUrl(url) {
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error("Error fetching schema from URL:", error);
    throw error;
  }
}

// Function to read schema from a local file
function readSchemaFromLocalFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath));
  } catch (error) {
    console.error("Error reading schema from local file:", error);
    throw error;
  }
}

// Function to fetch and process schema
async function fetchAndProcessSchema() {
  const schemaPath = process.env.SCHEMA_PATH;

  let userSchemaJson;
  if (schemaPath.startsWith("http://") || schemaPath.startsWith("https://")) {
    userSchemaJson = await fetchSchemaFromUrl(schemaPath);
  } else {
    const fullPath = path.join(__dirname, schemaPath);
    userSchemaJson = readSchemaFromLocalFile(fullPath);
  }

  fields = userSchemaJson.schema;
  properties = fields.properties;
  // console.log(properties, "properties");

  validFields = Object.keys(properties);
  console.log("Valid Fields:", validFields);

  config = fields.config;
}

// Function to build query based on filter and config
fetchAndProcessSchema()
  .then(() => {
    // console.log("Schema processing completed.");
    // console.log(fields, "fields");
    console.log("Valid Fields:", validFields);
    // console.log("Config:", config);
    // console.log(properties, "properties");
  })
  .catch((error) => {
    console.error("Error during schema processing:", error);
  });

// Function to build the query
function buildQuery(filter, config, properties, validFields) {
  const query = {};
  const rangeFields = config["fields_allowed_to_be_in_range"];

  for (const key in filter) {
    if (filter.hasOwnProperty(key)) {
      if (rangeFields.includes(key)) {
        const fieldType = properties[key].type;
        const filterValue = filter[key];

        console.log(fieldType, "type");
        console.log(filterValue, "value");
        if (typeof filterValue === "object" && filterValue !== null) {
          const { min, max } = filterValue;

          query[key] = {};
          if (fieldType === "date") {
            if (min !== undefined) query[key].$gte = min;
            if (max !== undefined) query[key].$lte = max;
          } else if (fieldType === "number") {
            if (min !== undefined) query[key].$gte = min;
            if (max !== undefined) query[key].$lte = max;
          }
        } else {
          query[key] = {};

          if (fieldType === "date") {
            const minDate = filterValue + "T00:00:00.000Z";
            const maxDate = filterValue + "T23:59:59.999Z";
            // console.log(query[key], "key");
            query[key].$gte = minDate;
            query[key].$lte = maxDate;
          } else {
            query[key] = filterValue;
          }
        }
      } else if (validFields.includes(key)) {
        query[key] = filter[key];
      } else {
        throw new Error(`Invalid field: ${key}`);
      }
    }
  }
  return query;
}

// Function to validate the request body
async function validateRequestBody(req, res) {
  if (!req.body || !req.body.request || !req.body.request.search) {
    return res
      .status(400)
      .json(
        createErrorResponse(
          "api.user.search",
          uuidv4(),
          "failed",
          "INVALID_REQUEST_BODY",
          "Invalid request body",
          400
        )
      );
  }
  return null;
}

// Function to validate the fields
async function validateFields(fields, validFields) {
  if (fields && Array.isArray(fields) && fields.length > 0) {
    const invalidFields = fields.filter(
      (field) => !validFields.includes(field)
    );
    console.log("Invalid Fields:", invalidFields);
    if (invalidFields.length > 0) {
      throw new Error(`Invalid fields: ${invalidFields.join(", ")}`);
    }
  }
}

// Main controller function for user search
exports.userSearch = searchAsync(async (req, res, next) => {
  try {
    console.log("----REQUEST RECEIVED---- ", req.body);

    // Validate request body
    const invalidBodyResponse = await validateRequestBody(req, res);
    if (invalidBodyResponse) return;

    const { filter, fields, limit, sort_by } = req.body.request.search;

    const query = buildQuery(filter, config, properties, validFields);
    console.log("----Query after processing filters:----", query);

    let fields_to_be_returned = config["response_fields_to_be_returned"];

    try {
      await validateFields(fields, validFields);
    } catch (error) {
      return res
        .status(400)
        .json(
          createErrorResponse(
            "api.user.search",
            uuidv4(),
            "failed",
            "INVALID_FIELD",
            error.message,
            400
          )
        );
    }

    const projection =
      fields.length > 0
        ? fields.join(" ") + " -_id"
        : fields_to_be_returned.join(" ") + " -_id";

    // Handling limit
    let queryLimit = 0;
    if (limit) {
      queryLimit = parseInt(limit, 10);
      if (isNaN(queryLimit) || queryLimit <= 0) {
        return res
          .status(400)
          .json(
            createErrorResponse(
              "api.user.search",
              uuidv4(),
              "failed",
              "INVALID_LIMIT",
              `Invalid limit value: ${limit}`,
              400
            )
          );
      }
    }

    console.log("----Query limit:----", queryLimit);

    // Handling sort options
    let sortOptions = {};
    if (sort_by) {
      for (const key in sort_by) {
        if (sort_by.hasOwnProperty(key) && validFields.includes(key)) {
          sortOptions[key] = sort_by[key] === "desc" ? -1 : 1;
        } else {
          return res
            .status(400)
            .json(
              createErrorResponse(
                "api.user.search",
                uuidv4(),
                "failed",
                "INVALID_SORT_FIELD",
                `Invalid sort field: ${key}`,
                400
              )
            );
        }
      }
    }

    console.log("----Sort options:----", sortOptions);

    // Build and execute the query
    const User = await createUserModel();

    const usersQuery = User.find(query).select(projection).sort(sortOptions);
    if (queryLimit > 0) {
      usersQuery.limit(queryLimit);
    }

    const users = await usersQuery;

    console.log("----Query result:----", users);

    if (users.length === 0) {
      return res
        .status(404)
        .json(
          createErrorResponse(
            "api.user.search",
            uuidv4(),
            "failed",
            "NOT_FOUND",
            "No users found matching the search criteria",
            404
          )
        );
    }

    const resmsgid = req.headers["x-request-id"] || uuidv4();

    const response = {
      id: "api.user.search",
      ver: "1.0",
      ts: new Date().toISOString(),
      params: {
        resmsgid: resmsgid,
        msgid: null,
        err: null,
        status: "successful",
        errmsg: null,
      },
      responseCode: "ok",
      result: {
        count: users.length,
        users: users,
      },
    };

    // console.log("----RESPONSE:----", response);

    res.status(200).json(response);
  } catch (error) {
    console.log("----ERROR----", error.message);
    res.status(500).json({
      id: "api.user.search",
      ver: "1.0",
      ts: new Date().toISOString(),
      params: {
        resmsgid: uuidv4(),
        msgid: null,
        err: "INTERNAL_SERVER_ERROR",
        status: "failed",
        errmsg: error.message || "internal server error",
      },
      responseCode: 500,
      result: null,
    });
  }
});

exports.validateRequestBody = validateRequestBody;
exports.fetchSchemaFromUrl = fetchSchemaFromUrl;
exports.readSchemaFromLocalFile = readSchemaFromLocalFile;
exports.fetchAndProcessSchema = fetchAndProcessSchema;
exports.validateFields = validateFields;
exports.buildQuery = buildQuery;
