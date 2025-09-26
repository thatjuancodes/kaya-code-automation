require('dotenv').config();

// server.js
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execPromise = promisify(exec);
const app = express();

// CORS middleware - must be before other middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Configuration
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || './workspace'; // Your codebase location

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Get file tree for context
async function getFileTree(dir, prefix = '') {
  const files = await fs.readdir(dir, { withFileTypes: true });
  let tree = '';
  
  for (const file of files) {
    // Skip node_modules, .git, etc
    if (file.name.startsWith('.') || file.name === 'node_modules') continue;
    
    const fullPath = path.join(dir, file.name);
    const relativePath = path.relative(WORKSPACE_DIR, fullPath);
    
    if (file.isDirectory()) {
      tree += `${prefix}📁 ${file.name}/\n`;
      tree += await getFileTree(fullPath, prefix + '  ');
    } else {
      tree += `${prefix}📄 ${file.name}\n`;
    }
  }
  return tree;
}

// Read file content
async function readFile(filePath, workspaceDir = WORKSPACE_DIR) {
  try {
    const fullPath = path.join(workspaceDir, filePath);
    const content = await fs.readFile(fullPath, 'utf8');
    return content;
  } catch (error) {
    return null;
  }
}

// Write file content
async function writeFile(filePath, content, workspaceDir = WORKSPACE_DIR) {
  const fullPath = path.join(workspaceDir, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf8');
}

// Git operations - always push to staging
async function gitCommitAndPushToStaging(prompt, changes, workspaceDir = WORKSPACE_DIR) {
  try {
    // Change to workspace directory
    process.chdir(workspaceDir);
    
    // Check git status
    const { stdout: status } = await execPromise('git status --porcelain');
    
    if (!status.trim()) {
      console.log('⚠️  No changes to commit');
      return { success: false, message: 'No changes detected' };
    }
    
    console.log('📊 Git status:', status);
    
    // Switch to staging branch (or create if doesn't exist)
    try {
      await execPromise('git checkout staging');
      console.log('✅ Switched to staging branch');
    } catch {
      // Branch doesn't exist, create it
      await execPromise('git checkout -b staging');
      console.log('🌿 Created staging branch');
    }
    
    // Pull latest from staging to avoid conflicts
    try {
      await execPromise('git pull origin staging');
      console.log('⬇️  Pulled latest from staging');
    } catch (e) {
      console.log('ℹ️  No remote staging yet or conflicts (continuing...)');
    }
    
    // Stage all changes
    await execPromise('git add .');
    console.log('✅ Staged changes');
    
    // Commit with AI prefix
    const commitMessage = `AI: ${prompt.slice(0, 72)}`;
    await execPromise(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
    console.log('💾 Committed:', commitMessage);
    
    // Push to staging
    await execPromise('git push origin staging');
    console.log('🚀 Pushed to staging → Netlify will auto-deploy');
    
    return {
      success: true,
      branch: 'staging',
      commitMessage,
      changes: changes,
      message: 'Pushed to staging - check Netlify for deployment'
    };
    
  } catch (error) {
    console.error('❌ Git error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// Main endpoint
app.post('/code', async (req, res) => {
  const { prompt, skipGit = false, projectId, directoryName } = req.body;
  
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // Determine workspace directory
  let workspaceDir = WORKSPACE_DIR;
  if (directoryName) {
    workspaceDir = path.join(WORKSPACE_DIR, directoryName);
    
    // Verify the project directory exists
    const projectExists = await fs.access(workspaceDir).then(() => true).catch(() => false);
    if (!projectExists) {
      return res.status(400).json({ 
        error: `Project directory '${directoryName}' not found. Please ensure the project is properly created.` 
      });
    }
  }

  console.log('📝 Received prompt:', prompt);
  console.log('📁 Working directory:', workspaceDir);
  console.log('🔧 Skip git:', skipGit);
  
  try {
    // Get repository structure
    const fileTree = await getFileTree(workspaceDir);
    
    console.log('🌳 File tree:', fileTree);

    // Build system prompt
    const systemPrompt = `You are an expert software engineer with access to a codebase. You can read and modify files.

CURRENT REPOSITORY STRUCTURE:
${fileTree}

INSTRUCTIONS:
1. Analyze the user's request
2. Determine which files need to be read or modified
3. Respond with JSON actions in this format:

For reading a file:
{
  "action": "read_file",
  "file": "path/to/file.js",
  "reason": "why you need to read it"
}

For modifying a file:
{
  "action": "write_file",
  "file": "path/to/file.js",
  "content": "FULL NEW FILE CONTENT HERE"
}

For completion:
{
  "action": "complete",
  "summary": "Brief summary of changes made"
}

RESPOND WITH ONE JSON OBJECT PER MESSAGE. Start by reading any files you need, then make modifications.`;

    const conversationHistory = [
      { 
        role: 'user', 
        content: `${systemPrompt}\n\nUSER REQUEST: ${prompt}` 
      }
    ];

    const changes = [];
    let maxIterations = 15;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      console.log(`\n🔄 Iteration ${iteration}...`);

      // Call Claude API
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: conversationHistory
      });

      const content = response.content[0].text;
      console.log('🤖 Claude response:', content.substring(0, 200) + '...');

      // Extract JSON
      let action;
      try {
        // Try multiple patterns to extract JSON
        let jsonStr = null;
        
        // Pattern 1: JSON in code block
        const codeBlockMatch = content.match(/```json\n([\s\S]+?)\n```/);
        if (codeBlockMatch) {
          jsonStr = codeBlockMatch[1];
        }
        
        // Pattern 2: Plain JSON object
        if (!jsonStr) {
          const plainJsonMatch = content.match(/\{[\s\S]*"action"[\s\S]*\}/);
          if (plainJsonMatch) {
            jsonStr = plainJsonMatch[0];
          }
        }
        
        if (jsonStr) {
          action = JSON.parse(jsonStr);
          console.log('📋 Parsed action:', action);
        } else {
          throw new Error('No JSON found');
        }
      } catch (e) {
        console.log('⚠️  Could not parse JSON:', e.message);
        console.log('Raw content:', content);
        conversationHistory.push(
          { role: 'assistant', content },
          { role: 'user', content: 'Please provide a valid JSON response with an action.' }
        );
        continue;
      }

      if (!action || !action.action) {
        break;
      }

      // Handle completion
      if (action.action === 'complete') {
        console.log('✅ Complete!');
        
        let gitResult = null;
        
        // Auto push to staging unless explicitly skipped
        if (!skipGit && changes.length > 0) {
          console.log('🔄 Auto-pushing to staging...');
          gitResult = await gitCommitAndPushToStaging(prompt, changes, workspaceDir);
        }
        
        return res.json({
          success: true,
          summary: action.summary,
          changes: changes,
          git: gitResult,
          netlifyUrl: gitResult?.success ? process.env.NETLIFY_STAGING_URL : null
        });
      }

      // Handle read file
      if (action.action === 'read_file') {
        const fileContent = await readFile(action.file, workspaceDir);
        
        if (fileContent === null) {
          conversationHistory.push(
            { role: 'assistant', content },
            { role: 'user', content: `Error: File ${action.file} not found. Try another approach.` }
          );
        } else {
          conversationHistory.push(
            { role: 'assistant', content },
            { 
              role: 'user', 
              content: `File ${action.file} content:\n\n\`\`\`\n${fileContent}\n\`\`\`` 
            }
          );
        }
        continue;
      }

      // Handle write file
      if (action.action === 'write_file') {
        await writeFile(action.file, action.content, workspaceDir);
        changes.push({
          file: action.file,
          action: 'modified'
        });
        
        console.log('💾 Wrote file:', action.file);
        
        conversationHistory.push(
          { role: 'assistant', content },
          { 
            role: 'user', 
            content: `✓ File ${action.file} has been written successfully. Continue with next action or complete.` 
          }
        );
        continue;
      }

      // Unknown action
      conversationHistory.push(
        { role: 'assistant', content },
        { role: 'user', content: 'Unknown action. Use: read_file, write_file, or complete.' }
      );
    }

    return res.json({
      success: true,
      message: 'Max iterations reached',
      changes: changes
    });

  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ 
      error: error.message,
      stack: error.stack
    });
  }
});

// New endpoint: Just push to staging (without code changes)
app.post('/git/push-staging', async (req, res) => {
  const { message = 'Manual changes' } = req.body;
  
  const result = await gitCommitAndPushToStaging(message, []);
  return res.json(result);
});

// Project Management Endpoints

// Create a new project (clone repo if needed)
app.post('/projects', async (req, res) => {
  const { project, cloneUrl } = req.body;

  if (!project || !cloneUrl) {
    return res.status(400).json({ 
      success: false, 
      error: 'Project details and clone URL are required' 
    });
  }

  console.log('📂 Creating project:', project.name);
  console.log('🔗 Clone URL:', cloneUrl);

  try {
    const projectDir = path.join(WORKSPACE_DIR, project.directoryName);
    
    // Check if directory already exists
    const dirExists = await fs.access(projectDir).then(() => true).catch(() => false);
    
    if (!dirExists) {
      console.log('📥 Cloning repository...');
      
      // Create workspace directory if it doesn't exist
      await fs.mkdir(WORKSPACE_DIR, { recursive: true });
      
      // Clone the repository
      await execPromise(`git clone ${cloneUrl} ${projectDir}`);
      console.log('✅ Repository cloned successfully');
      
      // Switch to staging branch (or create if doesn't exist)
      process.chdir(projectDir);
      try {
        await execPromise('git checkout staging');
        console.log('✅ Switched to staging branch');
      } catch {
        // Branch doesn't exist, create it
        await execPromise('git checkout -b staging');
        console.log('🌿 Created staging branch');
        
        // Push staging branch to remote
        try {
          await execPromise('git push -u origin staging');
          console.log('🚀 Pushed staging branch to remote');
        } catch (pushError) {
          console.log('⚠️  Could not push staging branch:', pushError.message);
        }
      }
    } else {
      console.log('📁 Directory already exists, skipping clone');
    }

    // Return to original directory
    process.chdir(__dirname);

    return res.json({
      success: true,
      project: {
        ...project,
        directoryName: project.directoryName,
        cloned: !dirExists
      }
    });

  } catch (error) {
    console.error('❌ Project creation error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// List all projects (scan workspace directory)
app.get('/projects', async (req, res) => {
  try {
    const workspaceExists = await fs.access(WORKSPACE_DIR).then(() => true).catch(() => false);
    
    if (!workspaceExists) {
      return res.json({
        success: true,
        projects: []
      });
    }

    const entries = await fs.readdir(WORKSPACE_DIR, { withFileTypes: true });
    const projectDirs = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({
        directoryName: entry.name,
        exists: true
      }));

    return res.json({
      success: true,
      projects: projectDirs
    });

  } catch (error) {
    console.error('❌ Failed to list projects:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete a project (remove directory)
app.delete('/projects/:directoryName', async (req, res) => {
  const { directoryName } = req.params;
  
  try {
    const projectDir = path.join(WORKSPACE_DIR, directoryName);
    
    // Check if directory exists
    const dirExists = await fs.access(projectDir).then(() => true).catch(() => false);
    
    if (dirExists) {
      // Remove directory recursively
      await fs.rm(projectDir, { recursive: true, force: true });
      console.log('🗑️  Deleted project directory:', directoryName);
    }

    return res.json({
      success: true,
      message: `Project ${directoryName} deleted`
    });

  } catch (error) {
    console.error('❌ Failed to delete project:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    workspace: WORKSPACE_DIR,
    apiKeyConfigured: !!ANTHROPIC_API_KEY
  });
});

// Serve the Kaya web app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'voice-app.html'));
});

app.use(express.static(__dirname)); // Serve static files

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Workspace: ${WORKSPACE_DIR}`);
  console.log(`🔑 API Key: ${ANTHROPIC_API_KEY ? 'Configured ✓' : 'Missing ✗'}`);
});
