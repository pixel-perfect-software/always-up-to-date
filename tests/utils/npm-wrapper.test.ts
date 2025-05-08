import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('NPM Wrapper Utility', () => {
  test('should install a package correctly', async () => {
    const packageName = 'lodash';
    const { stdout, stderr } = await execAsync(`npm install ${packageName}`);
    
    expect(stderr).toBe('');
    expect(stdout).toContain(`added 1 package`);
  });

  test('should uninstall a package correctly', async () => {
    const packageName = 'lodash';
    await execAsync(`npm install ${packageName}`); // Ensure it's installed first
    const { stdout, stderr } = await execAsync(`npm uninstall ${packageName}`);
    
    expect(stderr).toBe('');
    expect(stdout).toContain(`removed 1 package`);
  });

  test('should list installed packages', async () => {
    const { stdout, stderr } = await execAsync(`npm list --depth=0`);
    
    expect(stderr).toBe('');
    expect(stdout).toContain('lodash'); // Assuming lodash is installed
  });

  test('should check for outdated packages', async () => {
    const { stdout, stderr } = await execAsync(`npm outdated`);
    
    expect(stderr).toBe('');
    // The output will depend on the actual packages and their versions
    expect(stdout).toMatch(/Package\s+Current\s+Wanted\s+Latest\s+Location/);
  });
});