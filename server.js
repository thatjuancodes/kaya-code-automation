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
async function gitCommitAndPushToStaging(prompt, changes, workspaceDir = WORKSPACE_DIR, force = false) {
  const originalCwd = process.cwd();
  
  try {
    // Get absolute path for workspace directory
    const absoluteWorkspaceDir = path.resolve(workspaceDir);
    
    // Check git status
    const { stdout: status } = await execPromise('git status --porcelain', { cwd: absoluteWorkspaceDir });
    
    if (!status.trim()) {
      console.log('⚠️  No changes to commit');
      return { success: false, message: 'No changes detected' };
    }
    
    console.log('📊 Git status:', status);
    
    // Switch to staging branch (or create if doesn't exist)
    try {
      await execPromise('git checkout staging', { cwd: absoluteWorkspaceDir });
      console.log('✅ Switched to staging branch');
    } catch {
      // Branch doesn't exist, create it
      await execPromise('git checkout -b staging', { cwd: absoluteWorkspaceDir });
      console.log('🌿 Created staging branch');
    }
    
    // Pull latest from staging to avoid conflicts (skip if force pushing)
    if (!force) {
      try {
        await execPromise('git pull origin staging', { cwd: absoluteWorkspaceDir });
        console.log('⬇️  Pulled latest from staging');
      } catch (e) {
        console.log('ℹ️  No remote staging yet or conflicts (continuing...)');
      }
    }
    
    // Stage all changes
    await execPromise('git add .', { cwd: absoluteWorkspaceDir });
    console.log('✅ Staged changes');
    
    // Commit with AI prefix
    const commitMessage = `AI: ${prompt.slice(0, 72)}`;
    await execPromise(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, { cwd: absoluteWorkspaceDir });
    console.log('💾 Committed:', commitMessage);
    
    // Push to staging (with force if requested)
    const pushCommand = force ? 'git push --force origin staging' : 'git push origin staging';
    await execPromise(pushCommand, { cwd: absoluteWorkspaceDir });
    console.log(`🚀 ${force ? 'Force pushed' : 'Pushed'} to staging → Netlify will auto-deploy`);
    
    return {
      success: true,
      branch: 'staging',
      commitMessage,
      changes: changes,
      message: `${force ? 'Force pushed' : 'Pushed'} to staging - check Netlify for deployment`,
      forcePushed: force
    };
    
  } catch (error) {
    console.error('❌ Git error:', error.message);
    
    // Check if this is a non-fast-forward error
    const errorText = error.message.toLowerCase();
    const isNonFastForward = errorText.includes('non-fast-forward') || 
                            errorText.includes('rejected') ||
                            errorText.includes('failed to push some refs') ||
                            errorText.includes('behind') ||
                            (errorText.includes('updates were rejected') && errorText.includes('tip'));
    
    console.log('🔍 Git error analysis:');
    console.log('  - Error text:', errorText);
    console.log('  - Can force push:', isNonFastForward);
    
    return {
      success: false,
      error: error.message,
      canForcePush: isNonFastForward,
      gitError: true
    };
  } finally {
    // Always restore original working directory
    process.chdir(originalCwd);
  }
}

// Main endpoint
app.post('/code', async (req, res) => {
  const { prompt, skipGit = false, projectId, directoryName, forceGit = false } = req.body;
  
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

CRITICAL ASSUMPTION: Every user request expects you to make actual code changes unless explicitly stated otherwise (e.g., "just explain", "don't modify", "read only").

MANDATORY WORKFLOW:
1. Read the relevant files to understand current state
2. Make the requested changes by writing modified files
3. Only complete after making actual file modifications

USER EXPECTATIONS:
- The user ALWAYS wants code changes made
- If you think no changes are needed, you're probably wrong - look harder
- Every prompt should result in at least one file being written
- If the code already looks correct, improve it, add comments, or optimize it

Available actions:

For reading a file:
{
  "action": "read_file",
  "file": "path/to/file.js",
  "reason": "Need to understand current implementation"
}

For modifying a file (REQUIRED for every request):
{
  "action": "write_file",
  "file": "path/to/file.js",
  "content": "COMPLETE NEW FILE CONTENT WITH CHANGES"
}

For completion (ONLY after writing files):
{
  "action": "complete",
  "summary": "Specific changes made to which files"
}

FAILURE MODE TO AVOID: Never complete without writing files. If you complete without changes, you have failed the user's request.

WORKFLOW: Read files → Write modified files → Complete. No exceptions.`;

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
          console.log(`🔄 Auto-${forceGit ? 'force ' : ''}pushing to staging...`);
          gitResult = await gitCommitAndPushToStaging(prompt, changes, workspaceDir, forceGit);
        } else if (!skipGit && changes.length === 0) {
          console.log('⚠️ No changes were made to files, skipping git push');
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
  const { message = 'Manual changes', force = false, directoryName } = req.body;
  
  // Determine workspace directory
  let workspaceDir = WORKSPACE_DIR;
  if (directoryName) {
    workspaceDir = path.join(WORKSPACE_DIR, directoryName);
  }
  
  const result = await gitCommitAndPushToStaging(message, [], workspaceDir, force);
  return res.json(result);
});

// Force push endpoint for retrying failed pushes
app.post('/git/force-push', async (req, res) => {
  const { projectId, directoryName, message = 'Force push retry' } = req.body;
  
  if (!directoryName) {
    return res.status(400).json({ 
      success: false, 
      error: 'Directory name is required for force push' 
    });
  }

  // Determine workspace directory
  const workspaceDir = path.join(WORKSPACE_DIR, directoryName);
  
  // Verify the project directory exists
  const projectExists = await fs.access(workspaceDir).then(() => true).catch(() => false);
  if (!projectExists) {
    return res.status(400).json({ 
      success: false,
      error: `Project directory '${directoryName}' not found.` 
    });
  }

  console.log('🔄 Force pushing to staging for project:', directoryName);
  
  try {
    // Get absolute path for workspace directory
    const absoluteWorkspaceDir = path.resolve(workspaceDir);
    
    // Make sure we're on staging branch
    await execPromise('git checkout staging', { cwd: absoluteWorkspaceDir });
    console.log('✅ On staging branch');
    
    // Simply force push whatever is currently committed
    await execPromise('git push --force origin staging', { cwd: absoluteWorkspaceDir });
    console.log('🚀 Force pushed to staging → Netlify will auto-deploy');
    
    return res.json({
      success: true,
      branch: 'staging',
      message: 'Force pushed to staging - check Netlify for deployment',
      forcePushed: true
    });
    
  } catch (error) {
    console.error('❌ Force push error:', error.message);
    return res.json({
      success: false,
      error: error.message,
      gitError: true
    });
  }
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
      try {
        await execPromise('git checkout staging', { cwd: projectDir });
        console.log('✅ Switched to staging branch');
      } catch {
        // Branch doesn't exist, create it
        await execPromise('git checkout -b staging', { cwd: projectDir });
        console.log('🌿 Created staging branch');
        
        // Push staging branch to remote
        try {
          await execPromise('git push -u origin staging', { cwd: projectDir });
          console.log('🚀 Pushed staging branch to remote');
        } catch (pushError) {
          console.log('⚠️  Could not push staging branch:', pushError.message);
        }
      }
    } else {
      console.log('📁 Directory already exists, skipping clone');
    }

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
